#!/usr/bin/env tsx
/**
 * Generate the PDF edge-case corpus.
 *
 *   npx tsx scripts/make-variants.ts            # everything
 *   npx tsx scripts/make-variants.ts --only=enc # name substring filter
 *
 * One representative file per axis, written to test-corpus/variants/. Each is
 * re-opened with pdf.js before it is kept, so a variant that reaches the OCR
 * matrix is known to be a *readable* PDF — a failure downstream is then about
 * the axis, not about this generator.
 *
 * Pixels come from one page of a document that already OCRs cleanly, so that
 * encoding and colour variants differ only in how the same ink is stored.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createCanvas, Image } from "@napi-rs/canvas";
import { deflateSync } from "node:zlib";
import {
  PdfDoc,
  addImagePage,
  addTextPage,
  appendIncrementalUpdate,
  lastStartxref,
  type ImageSpec,
} from "./lib/pdfwriter";
import { rasterize, loadPdf } from "./lib/pdf";

const OUT = "test-corpus/variants";
const WORKING_SOURCE = "test-corpus/Matt smith 2022 contract.pdf";
const SHARP_SOURCE =
  "test-corpus/Order-and-Decision_HDO3-Holdings_C11-0001341-LIC_6.10.2024.pdf";

/** Wide enough that 9pt body text survives; small enough to keep files light. */
const RASTER_WIDTH = 1240;

// ---------------------------------------------------------------------------
// Source pixels
// ---------------------------------------------------------------------------

interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  rgba: Buffer;
  /** The original PNG, for re-encoding through canvas. */
  png: Buffer;
}

async function sourcePixels(file: string, pageIndex: number): Promise<Pixels> {
  const [raster] = await rasterize(new Uint8Array(await readFile(file)), [pageIndex]);
  const image = new Image();
  image.src = raster.png;
  const scale = RASTER_WIDTH / image.width;
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return {
    width,
    height,
    rgba: Buffer.from(context.getImageData(0, 0, width, height).data),
    png: canvas.toBuffer("image/png"),
  };
}

// ---------------------------------------------------------------------------
// Image encoders — each returns a complete ImageSpec
// ---------------------------------------------------------------------------

function jpeg(pixels: Pixels, quality = 0.85): ImageSpec {
  const image = new Image();
  image.src = pixels.png;
  const canvas = createCanvas(pixels.width, pixels.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pixels.width, pixels.height);
  context.drawImage(image, 0, 0, pixels.width, pixels.height);
  return {
    width: pixels.width,
    height: pixels.height,
    data: canvas.toBuffer("image/jpeg", quality),
    filter: "/DCTDecode",
    colorSpace: "/DeviceRGB",
    bitsPerComponent: 8,
  };
}

const luma = (rgba: Buffer, at: number) =>
  Math.round(0.299 * rgba[at] + 0.587 * rgba[at + 1] + 0.114 * rgba[at + 2]);

function flateGray(pixels: Pixels): ImageSpec {
  const out = Buffer.alloc(pixels.width * pixels.height);
  for (let i = 0; i < out.length; i++) out[i] = luma(pixels.rgba, i * 4);
  return {
    width: pixels.width,
    height: pixels.height,
    data: deflateSync(out),
    filter: "/FlateDecode",
    colorSpace: "/DeviceGray",
    bitsPerComponent: 8,
  };
}

function flateRgb(pixels: Pixels): ImageSpec {
  const out = Buffer.alloc(pixels.width * pixels.height * 3);
  for (let i = 0, o = 0; i < pixels.rgba.length; i += 4, o += 3) {
    out[o] = pixels.rgba[i];
    out[o + 1] = pixels.rgba[i + 1];
    out[o + 2] = pixels.rgba[i + 2];
  }
  return {
    width: pixels.width,
    height: pixels.height,
    data: deflateSync(out),
    filter: "/FlateDecode",
    colorSpace: "/DeviceRGB",
    bitsPerComponent: 8,
  };
}

function flateCmyk(pixels: Pixels): ImageSpec {
  // Naive RGB→CMYK; fidelity does not matter, the point is the colour space.
  const out = Buffer.alloc(pixels.width * pixels.height * 4);
  for (let i = 0, o = 0; i < pixels.rgba.length; i += 4, o += 4) {
    const r = pixels.rgba[i] / 255;
    const g = pixels.rgba[i + 1] / 255;
    const b = pixels.rgba[i + 2] / 255;
    const k = 1 - Math.max(r, g, b);
    const d = 1 - k || 1;
    out[o] = Math.round((((1 - r - k) / d) * 255));
    out[o + 1] = Math.round((((1 - g - k) / d) * 255));
    out[o + 2] = Math.round((((1 - b - k) / d) * 255));
    out[o + 3] = Math.round(k * 255);
  }
  return {
    width: pixels.width,
    height: pixels.height,
    data: deflateSync(out),
    filter: "/FlateDecode",
    colorSpace: "/DeviceCMYK",
    bitsPerComponent: 8,
  };
}

/** 8-bit indices into a 256-entry grey palette. */
function flateIndexed(pixels: Pixels): ImageSpec {
  const out = Buffer.alloc(pixels.width * pixels.height);
  for (let i = 0; i < out.length; i++) out[i] = luma(pixels.rgba, i * 4);
  const palette = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) palette.fill(i, i * 3, i * 3 + 3);
  return {
    width: pixels.width,
    height: pixels.height,
    data: deflateSync(out),
    filter: "/FlateDecode",
    colorSpace: `[/Indexed /DeviceRGB 255 <${palette.toString("hex")}>]`,
    bitsPerComponent: 8,
  };
}

/** Pack to 1 bit per pixel, MSB first, rows padded to byte boundaries. */
function packBilevel(pixels: Pixels, threshold = 160): Buffer {
  const rowBytes = Math.ceil(pixels.width / 8);
  const out = Buffer.alloc(rowBytes * pixels.height);
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      // 1 = white in DeviceGray; ink is 0.
      if (luma(pixels.rgba, (y * pixels.width + x) * 4) >= threshold) {
        out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

function flateBilevel(pixels: Pixels): ImageSpec {
  return {
    width: pixels.width,
    height: pixels.height,
    data: deflateSync(packBilevel(pixels)),
    filter: "/FlateDecode",
    colorSpace: "/DeviceGray",
    bitsPerComponent: 1,
  };
}

/**
 * The same bits as a stencil mask. /ImageMask inverts the sense — a 1 bit is
 * *masked out* — so ink must become 1, hence the /Decode flip.
 */
function imageMask(pixels: Pixels): ImageSpec {
  return {
    width: pixels.width,
    height: pixels.height,
    data: deflateSync(packBilevel(pixels)),
    filter: "/FlateDecode",
    colorSpace: "",
    bitsPerComponent: 1,
    imageMask: true,
    decode: "[1 0]",
  };
}

// ---------------------------------------------------------------------------
// Real CCITT G4 streams, lifted out of the Sharp copier scan
// ---------------------------------------------------------------------------

interface CcittImage {
  data: Buffer;
  width: number;
  height: number;
  k: number;
}

/**
 * Pull the raw `/CCITTFaxDecode` streams straight out of the Sharp file. There
 * is no G4 encoder on this machine, and a real copier's bitstream is a better
 * test subject than anything we could synthesize anyway.
 */
async function extractCcitt(file: string, limit: number): Promise<CcittImage[]> {
  const raw = await readFile(file);
  const text = raw.toString("latin1");
  // Object lengths are indirect (`/Length 7 0 R`) in this file, so resolve them.
  const lengths = new Map<number, number>();
  for (const m of text.matchAll(/(\d+) 0 obj\s*(\d+)\s*endobj/g)) {
    lengths.set(Number(m[1]), Number(m[2]));
  }

  const out: CcittImage[] = [];
  const objectRe = /(\d+) 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  for (const match of text.matchAll(objectRe)) {
    if (out.length >= limit) break;
    const dict = match[2];
    if (!dict.includes("/CCITTFaxDecode")) continue;
    const width = Number(/\/Width\s+(\d+)/.exec(dict)?.[1]);
    const height = Number(/\/Height\s+(\d+)/.exec(dict)?.[1]);
    const k = Number(/\/K\s+(-?\d+)/.exec(dict)?.[1] ?? 0);
    const lengthRef = /\/Length\s+(\d+) 0 R/.exec(dict)?.[1];
    const length = lengthRef
      ? lengths.get(Number(lengthRef))
      : Number(/\/Length\s+(\d+)/.exec(dict)?.[1]);
    if (!width || !height || !length) continue;
    const start = match.index! + match[0].length;
    out.push({ data: raw.subarray(start, start + length), width, height, k });
  }
  if (out.length === 0) throw new Error(`no CCITT streams found in ${file}`);
  return out;
}

function ccittSpec(image: CcittImage, indirectLength = false): ImageSpec {
  return {
    width: image.width,
    height: image.height,
    data: image.data,
    filter: "/CCITTFaxDecode",
    colorSpace: "/DeviceGray",
    bitsPerComponent: 1,
    decodeParms: `<< /K ${image.k} /Columns ${image.width} /Rows ${image.height} >>`,
    indirectLength,
  };
}

// ---------------------------------------------------------------------------
// Variant catalogue
// ---------------------------------------------------------------------------

interface Variant {
  name: string;
  axis: string;
  /** What we expect to learn; copied into the findings table. */
  note: string;
  build: () => Promise<Buffer> | Buffer;
  /** Some variants are meant to be unopenable; skip the pdf.js gate for those. */
  expectUnreadable?: boolean;
}

const BODY_LINES = [
  "MEMORANDUM OF UNDERSTANDING",
  "",
  "This instrument is executed by the parties named below on the",
  "seventeenth day of March. The licensee shall maintain records",
  "of every transaction for a period of not less than three years.",
  "",
  "Reference number: QX-4471-B    Docket: C11-0001341-LIC",
  "Filed with the clerk of the superior court, Whatcom County.",
];

function imageOnly(spec: ImageSpec, extras?: Parameters<typeof addImagePage>[2]): Buffer {
  const doc = new PdfDoc();
  addImagePage(doc, spec, extras);
  return doc.build();
}

async function catalogue(): Promise<Variant[]> {
  const pixels = await sourcePixels(WORKING_SOURCE, 0);
  const ccitt = await extractCcitt(SHARP_SOURCE, 3);
  const small = jpeg(pixels, 0.5);
  const variants: Variant[] = [];
  const add = (v: Variant) => variants.push(v);

  // -- controls ------------------------------------------------------------
  add({
    name: "control-text-only",
    axis: "control",
    note: "Born-digital painted text, written by this generator. Positive control for the writer itself.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      return doc.build();
    },
  });
  add({
    name: "control-image-plus-text",
    axis: "control",
    note: "Same scanned image as the encoding variants, plus one painted text line. Separates 'can it OCR pixels' from 'can it read a text layer'.",
    build: () => {
      const doc = new PdfDoc();
      addImagePage(doc, small, { pageExtra: "" });
      addTextPage(doc, ["MARKER LINE ALPHA-SEVEN painted as real text."]);
      return doc.build();
    },
  });

  // Same page every time — text across the top, an image below it that never
  // touches the text — with only the image's footprint changing. Together these
  // separate "text under an image is dropped" from "a page dominated by an
  // image is dropped", which is what decides whether any repair is possible.
  const imageProbes: [string, string, string][] = [
    ["small", "160 0 0 200 72 80", "small image in the bottom corner (~7% of the page)"],
    ["half", "612 0 0 396 0 0", "image covering the bottom half of the page, still clear of the text"],
  ];
  for (const [label, imageBox, description] of imageProbes) {
    add({
      name: `probe-text-plus-${label}-image`,
      axis: "control",
      note: `One page: text across the top, ${description}.`,
      build: () => {
      const doc = new PdfDoc();
      const thumb = jpeg(pixels, 0.4);
      const imageRef = doc.add(
        `<< /Type /XObject /Subtype /Image /Width ${thumb.width} /Height ${thumb.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
          `/Length ${thumb.data.length} >>`,
        thumb.data
      );
      const fontRef = doc.add(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
      );
      const body =
        `BT /F1 11 Tf 72 720 Td 14 TL\n` +
        ["SMALL IMAGE PROBE MARKER", ...BODY_LINES]
          .map((l) => `(${l.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`)
          .join("\n") +
        // Image sits low on the page, well clear of the text block above.
        `\nET\nq ${imageBox} cm /Im0 Do Q\n`;
      const content = Buffer.from(body, "latin1");
      const contentRef = doc.add(`<< /Length ${content.length} >>`, content);
      doc.addPage(
        `<< /Type /Page /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${fontRef} >> /XObject << /Im0 ${imageRef} >> >> ` +
          `/Contents ${contentRef} >>`
      );
        return doc.build();
      },
    });
  }

  // -- encoding ------------------------------------------------------------
  add({
    name: "enc-ccitt-g4",
    axis: "encoding",
    note: "Real Group 4 bitstream from the Sharp copier, in a clean minimal container.",
    build: () => imageOnly(ccittSpec(ccitt[0])),
  });
  add({
    name: "enc-ccitt-g4-indirect-length",
    axis: "encoding",
    note: "As above but /Length is an indirect reference, exactly as the Sharp file writes it.",
    build: () => imageOnly(ccittSpec(ccitt[0], true)),
  });
  add({
    name: "enc-dct-jpeg",
    axis: "encoding",
    note: "DeviceRGB JPEG — the most common scanned-page encoding.",
    build: () => imageOnly(jpeg(pixels)),
  });
  add({
    name: "enc-flate-gray",
    axis: "encoding",
    note: "Uncompressed-then-deflated 8-bit grey. No lossy codec in the path.",
    build: () => imageOnly(flateGray(pixels)),
  });
  add({
    name: "enc-flate-bilevel",
    axis: "encoding",
    note: "1-bit bilevel via Flate — same ink as the CCITT variants, different codec.",
    build: () => imageOnly(flateBilevel(pixels)),
  });

  // -- colour --------------------------------------------------------------
  add({
    name: "color-rgb-flate",
    axis: "colour",
    note: "DeviceRGB, 8 bits per component.",
    build: () => imageOnly(flateRgb(pixels)),
  });
  add({
    name: "color-cmyk",
    axis: "colour",
    note: "DeviceCMYK, four components — print-origin PDFs land here.",
    build: () => imageOnly(flateCmyk(pixels)),
  });
  add({
    name: "color-indexed",
    axis: "colour",
    note: "Indexed palette colour space.",
    build: () => imageOnly(flateIndexed(pixels)),
  });
  add({
    name: "color-imagemask",
    axis: "colour",
    note: "/ImageMask stencil painted with the fill colour rather than an image.",
    build: () => imageOnly(imageMask(pixels)),
  });

  // -- structure -----------------------------------------------------------
  add({
    name: "struct-xref-stream",
    axis: "structure",
    note: "PDF 1.5 cross-reference stream plus an object stream holding the page dictionaries.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      return doc.build({ version: "1.5", xref: "stream" });
    },
  });
  add({
    name: "struct-pdf20",
    axis: "structure",
    note: "PDF 2.0 header.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      return doc.build({ version: "2.0" });
    },
  });
  add({
    name: "struct-incremental-update",
    axis: "structure",
    note: "Two revisions: the second appends an updated page dictionary with /Rotate 0 and chains via /Prev.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      const base = doc.build();
      const text = base.toString("latin1");
      const pageNum = Number(/(\d+) 0 obj\s*<< \/Type \/Page /.exec(text)?.[1]);
      const pageDict = /(?:\d+) 0 obj\s*(<< \/Type \/Page [\s\S]*?>>)\s*endobj/.exec(text)?.[1];
      if (!pageNum || !pageDict) throw new Error("could not locate the page object to update");
      const size = Number(/\/Size (\d+)/.exec(text)![1]);
      const root = /\/Root (\d+ 0 R)/.exec(text)![1];
      return appendIncrementalUpdate(
        base,
        [{ num: pageNum, dict: pageDict.replace(">>", "/Rotate 0 >>") }],
        { size, root, prev: lastStartxref(base) }
      );
    },
  });
  add({
    name: "struct-damaged-xref",
    axis: "structure",
    note: "Every xref offset shifted by 137 bytes. Readers must rebuild by scanning.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      return doc.build({ corruptXref: true });
    },
  });
  add({
    name: "struct-no-binary-comment",
    axis: "structure",
    note: "Line-2 comment carries no high bytes, so naive tooling may treat the file as text. Matches the Sharp file's '%Sharp Non-Encryption'. Text page, so the no-text-layer effect cannot confound it.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      return doc.build({ noBinaryComment: true });
    },
  });

  // -- security ------------------------------------------------------------
  add({
    name: "sec-owner-password-only",
    axis: "security",
    note: "Encrypted with an empty user password: opens with no prompt, but copy/print are denied.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      return doc.build({
        encrypt: { userPassword: "", ownerPassword: "owner-secret", permissions: -44 },
      });
    },
  });
  add({
    name: "sec-user-password",
    axis: "security",
    note: "Genuinely locked — needs a password to open at all.",
    expectUnreadable: true,
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      return doc.build({
        encrypt: { userPassword: "open-me", ownerPassword: "owner-secret", permissions: -1 },
      });
    },
  });

  // -- content -------------------------------------------------------------
  add({
    name: "content-hidden-ocr-layer",
    axis: "content",
    note: "Scanned image with an invisible (Tr 3) text layer over it — what a scanner's own OCR produces.",
    build: () => {
      const doc = new PdfDoc();
      addImagePage(doc, small);
      addTextPage(doc, ["HIDDEN LAYER MARKER BRAVO-NINE", ...BODY_LINES], {
        renderMode: 3,
      });
      return doc.build();
    },
  });
  add({
    name: "content-mixed-native-and-scan",
    axis: "content",
    note: "Page 1 born-digital, page 2 a pure scan. Tests whether a text layer on one page suppresses OCR on the other.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      addImagePage(doc, small);
      return doc.build();
    },
  });
  add({
    name: "content-acroform",
    axis: "content",
    note: "AcroForm with a filled text field; field values live outside the page content stream.",
    build: () => {
      const doc = new PdfDoc();
      const page = addTextPage(doc, ["APPLICATION FORM — see field below."]);
      const field = doc.add(
        `<< /Type /Annot /Subtype /Widget /FT /Tx /T (applicant) ` +
          `/V (Marguerite Delacroix-Whitfield) /Rect [72 600 400 620] ` +
          `/F 4 /P ${page} >>`
      );
      const pageObject = doc as unknown as { objects: { num: number; dict: string }[] };
      const entry = pageObject.objects[page.num - 1];
      entry.dict = entry.dict.replace(">>", `/Annots [${field}] >>`);
      doc.catalogExtra = ` /AcroForm << /Fields [${field}] >>`;
      return doc.build();
    },
  });
  add({
    name: "content-annotations",
    axis: "content",
    note: "Free-text annotation over a normal page — text a reader shows but the content stream does not contain.",
    build: () => {
      const doc = new PdfDoc();
      const page = addTextPage(doc, BODY_LINES);
      const annot = doc.add(
        `<< /Type /Annot /Subtype /FreeText /Rect [72 560 460 590] ` +
          `/Contents (ANNOTATION MARKER CHARLIE-THREE) /DA (0 g /F1 11 Tf) /F 4 >>`
      );
      const objects = (doc as unknown as { objects: { num: number; dict: string }[] }).objects;
      const entry = objects[page.num - 1];
      entry.dict = entry.dict.replace(">>", `/Annots [${annot}] >>`);
      return doc.build();
    },
  });
  add({
    name: "content-embedded-attachment",
    axis: "content",
    note: "Carries an embedded file attachment alongside the page content.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES);
      const payload = Buffer.from("attached,csv,payload\n1,2,3\n", "latin1");
      const stream = doc.add(
        `<< /Type /EmbeddedFile /Subtype /text#2Fcsv /Length ${payload.length} >>`,
        payload
      );
      const spec = doc.add(
        `<< /Type /Filespec /F (data.csv) /UF (data.csv) /EF << /F ${stream} >> >>`
      );
      doc.catalogExtra = ` /Names << /EmbeddedFiles << /Names [(data.csv) ${spec}] >> >>`;
      return doc.build();
    },
  });

  // -- geometry ------------------------------------------------------------
  // Text pages, not scans: an image-only page returns nothing for reasons that
  // have nothing to do with geometry, which would make the whole axis unreadable.
  for (const rotate of [90, 180, 270]) {
    add({
      name: `geom-rotate-${rotate}`,
      axis: "geometry",
      note: `/Rotate ${rotate}. Upright text, rotated presentation.`,
      build: () => {
        const doc = new PdfDoc();
        addTextPage(doc, [`ROTATE ${rotate} MARKER`, ...BODY_LINES], { rotate });
        return doc.build();
      },
    });
  }
  add({
    name: "geom-nonzero-mediabox-origin",
    axis: "geometry",
    note: "MediaBox origin at [20 30], so page space and PDF-user space disagree about zero.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, ["NONZERO ORIGIN MARKER", ...BODY_LINES], {
        mediaBox: [20, 30, 632, 822],
      });
      return doc.build();
    },
  });
  add({
    name: "geom-cropbox-smaller",
    axis: "geometry",
    note: "CropBox is an inset of MediaBox — viewers show the crop, so reported geometry must follow it.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, ["CROPBOX MARKER", ...BODY_LINES], {
        mediaBox: [0, 0, 612, 792],
        cropBox: [60, 80, 552, 712],
      });
      return doc.build();
    },
  });
  add({
    name: "geom-mixed-page-sizes",
    axis: "geometry",
    note: "Letter, then A5, then a wide landscape page in one file.",
    build: () => {
      const doc = new PdfDoc();
      addTextPage(doc, BODY_LINES, { width: 612, height: 792 });
      addTextPage(doc, ["A5 PAGE MARKER DELTA-ONE"], { width: 420, height: 595 });
      addTextPage(doc, ["LANDSCAPE PAGE MARKER ECHO-TWO"], { width: 1224, height: 612 });
      return doc.build();
    },
  });
  // Three sizes, to find where an oversized page starts to fail rather than
  // just recording that the extreme does.
  for (const side of [1584, 5000, 14400]) {
    add({
      name: `geom-large-page-${side}`,
      axis: "geometry",
      note: `${side}pt square page (${(side / 72).toFixed(0)} inches). Locates the page-dimension ceiling.`,
      build: () => {
        const doc = new PdfDoc();
        addTextPage(doc, [`LARGE PAGE ${side} MARKER`, ...BODY_LINES], {
          width: side,
          height: side,
        });
        return doc.build();
      },
    });
  }

  // -- scale ---------------------------------------------------------------
  // Every page carries a unique marker so a truncated reply is visible as
  // "markers 1..N came back, the rest did not" rather than just a page count.
  const manyPages = (count: number) => () => {
    const doc = new PdfDoc();
    for (let i = 1; i <= count; i++) {
      addTextPage(doc, [`PAGE MARKER ${i} OF ${count}`, ...BODY_LINES]);
    }
    return doc.build();
  };
  add({
    name: "scale-1-page",
    axis: "scale",
    note: "Single-page floor.",
    build: manyPages(1),
  });
  // 150 and 520 both came back with exactly 50 markers; 45 and 60 bracket that
  // ceiling so the preflight threshold is measured rather than guessed.
  add({
    name: "scale-45-pages",
    axis: "scale",
    note: "45 pages — just under the observed ceiling.",
    build: manyPages(45),
  });
  add({
    name: "scale-60-pages",
    axis: "scale",
    note: "60 pages — just over the observed ceiling.",
    build: manyPages(60),
  });
  add({
    name: "scale-150-pages",
    axis: "scale",
    note: "150 pages, still comfortably under the byte cap.",
    build: manyPages(150),
  });
  add({
    name: "scale-520-pages",
    axis: "scale",
    note: "520 pages — past any plausible per-request page budget.",
    build: manyPages(520),
  });
  add({
    name: "scale-over-20mb",
    axis: "scale",
    note: "Over Interfaze's 20 MB base64 ceiling on few pages: byte size and page count are independent axes.",
    build: () => {
      const doc = new PdfDoc();
      // Text pages so that, if the size ceiling were not the blocker, there
      // would be something to extract.
      for (let i = 1; i <= 6; i++) {
        addTextPage(doc, [`OVERSIZE PAGE MARKER ${i}`, ...BODY_LINES]);
      }
      // Pad with an incompressible stream so the file crosses 20 MB without
      // needing hundreds of pages.
      const filler = Buffer.alloc(21_000_000);
      for (let i = 0; i < filler.length; i++) filler[i] = (i * 2654435761) & 0xff;
      doc.add(`<< /Type /EmbeddedFile /Length ${filler.length} >>`, filler);
      return doc.build();
    },
  });

  return variants;
}

// ---------------------------------------------------------------------------

async function verify(data: Buffer): Promise<string> {
  const { pdf } = await loadPdf(new Uint8Array(data));
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    page.cleanup();
    return `${pdf.numPages}pp ${Math.round(viewport.width)}x${Math.round(viewport.height)}`;
  } finally {
    await pdf.destroy();
  }
}

async function main() {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  await mkdir(OUT, { recursive: true });
  const variants = (await catalogue()).filter((v) => !only || v.name.includes(only));
  const manifest: Record<string, { axis: string; note: string; bytes: number; opens: string }> = {};

  for (const variant of variants) {
    const data = await variant.build();
    const dest = path.join(OUT, `${variant.name}.pdf`);
    await writeFile(dest, data);
    let opens: string;
    try {
      opens = await verify(data);
    } catch (e) {
      opens = `UNREADABLE: ${e instanceof Error ? e.message : String(e)}`;
      if (!variant.expectUnreadable) {
        console.log(`  ✗ ${variant.name.padEnd(32)} ${opens}`);
        manifest[variant.name] = { axis: variant.axis, note: variant.note, bytes: data.length, opens };
        continue;
      }
    }
    console.log(
      `  ✓ ${variant.name.padEnd(32)} ${(data.length / 1e6).toFixed(2)}MB  ${opens}`
    );
    manifest[variant.name] = { axis: variant.axis, note: variant.note, bytes: data.length, opens };
  }

  await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\n${variants.length} variant(s) → ${OUT}/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});

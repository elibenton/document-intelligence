/**
 * Rebuild a PDF that a provider cannot decode into one it can.
 *
 * Office copiers and fax machines emit CCITT Group 4 bilevel scans
 * (`/CCITTFaxDecode`), which is the default for most legal-document scanning.
 * Interfaze's PDF pipeline returns *empty* OCR for those files — no error, no
 * text, tokens still billed. pdf.js decodes them fine, so the repair is to
 * rasterize locally and re-embed each page as a JPEG (`/DCTDecode`), which
 * every decoder handles.
 *
 * The output is one PDF, so the document still takes a single whole-file OCR
 * call — this is a repair step, not a per-page fan-out.
 */

import { createCanvas, Image } from "@napi-rs/canvas";
import { rasterize } from "./pdf";

/** Filters that signal a PDF a provider may not be able to decode. */
const RISKY_FILTERS = ["/CCITTFaxDecode", "/JBIG2Decode", "/JPXDecode"];

/**
 * Cheap structural sniff for encodings known to defeat provider-side decoding.
 * Reads the raw bytes rather than parsing — these tokens appear as literal
 * names in the object dictionaries.
 */
export function riskyFilters(data: Uint8Array): string[] {
  // Filter names are ASCII; scanning latin1 avoids decoding binary streams.
  const head = Buffer.from(data).toString("latin1");
  return RISKY_FILTERS.filter((filter) => head.includes(filter));
}

function pdfEscape(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Assemble a PDF whose pages are single full-bleed JPEG images.
 *
 * Written by hand rather than with a PDF library: the structure is a dozen
 * objects and the alternative is another dependency in the Convex bundle.
 */
export function pdfFromJpegPages(
  pages: { jpeg: Buffer; width: number; height: number }[]
): Buffer {
  if (pages.length === 0) throw new Error("Cannot build a PDF with no pages");

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (buf: Buffer | string) => {
    const b = typeof buf === "string" ? Buffer.from(buf, "latin1") : buf;
    chunks.push(b);
    length += b.length;
  };
  const beginObject = (n: number) => {
    offsets[n - 1] = length;
    push(`${n} 0 obj\n`);
  };

  push("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");

  // 1 catalog, 2 page tree, then per page: page, content stream, image.
  const objectCount = 2 + pages.length * 3;
  const pageObj = (i: number) => 3 + i * 3;
  const contentObj = (i: number) => 4 + i * 3;
  const imageObj = (i: number) => 5 + i * 3;

  beginObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObject(2);
  push(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages
      .map((_, i) => `${pageObj(i)} 0 R`)
      .join(" ")}] >>\nendobj\n`
  );

  pages.forEach((page, i) => {
    beginObject(pageObj(i));
    push(
      `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${pdfEscape(page.width)} ${pdfEscape(page.height)}] ` +
        `/Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >> ` +
        `/Contents ${contentObj(i)} 0 R >>\nendobj\n`
    );

    // Draw the image at full page size.
    const content = `q ${pdfEscape(page.width)} 0 0 ${pdfEscape(page.height)} 0 0 cm /Im0 Do Q\n`;
    beginObject(contentObj(i));
    push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n`);
    push(content);
    push("endstream\nendobj\n");

    beginObject(imageObj(i));
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${page.jpeg.length} >>\nstream\n`
    );
    push(page.jpeg);
    push("\nendstream\nendobj\n");
  });

  const xrefOffset = length;
  push(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= objectCount; n++) {
    push(`${String(offsets[n - 1]).padStart(10, "0")} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`
  );

  return Buffer.concat(chunks);
}

/** Rasterize every page and rebuild the document as a JPEG-backed PDF. */
export async function normalizePdf(
  data: Uint8Array,
  options?: { quality?: number }
): Promise<Buffer> {
  const rasters = await rasterize(data);
  const pages = rasters.map((raster) => ({
    jpeg: toJpeg(raster.png, options?.quality ?? 0.82),
    width: raster.width,
    height: raster.height,
  }));
  return pdfFromJpegPages(pages);
}

/**
 * Re-encode a PNG buffer as JPEG. Kept separate so the PDF builder stays
 * dependency-free and testable with fixed bytes.
 */
function toJpeg(png: Buffer, quality: number): Buffer {
  // @napi-rs/canvas is already a dependency (pdf.js renders through it).
  const image = new Image();
  image.src = png;
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  return canvas.toBuffer("image/jpeg", quality);
}

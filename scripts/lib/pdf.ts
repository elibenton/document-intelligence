/**
 * Local PDF ground truth for the scan bench.
 *
 * Everything here runs offline against pdfjs-dist — no Interfaze, no Convex.
 * That matters: for a born-digital PDF the embedded text layer is a free,
 * perfect oracle for OCR accuracy, and the page count is the only way to catch
 * `ocrToPages` mis-inferring pagination.
 *
 * The pdfjs wiring (asset dirs, legacy build, canvas factory) mirrors
 * convex/renderPages.ts so the bench rasterizes exactly what production does.
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

const TARGET_WIDTH = 1600;
const MAX_SCALE = 4;

export type NativeTextVisibility = "visible" | "hidden" | "mixed" | "none";

export interface TruthPage {
  pageNumber: number; // 0-indexed, matching the app
  width: number;
  height: number;
  text: string;
  visibility: NativeTextVisibility;
}

export interface PdfTruth {
  pageCount: number;
  pages: TruthPage[];
  /** Share of pages whose native text is genuinely painted (not an OCR layer). */
  visibleTextRatio: number;
  /** True when the native text layer is good enough to serve as an OCR oracle. */
  usableAsOracle: boolean;
}

function assetDir(dir: "standard_fonts" | "wasm" | "cmaps" | "iccs") {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("pdfjs-dist/package.json");
    return path.join(path.dirname(pkg), dir) + path.sep;
  } catch {
    return undefined;
  }
}

export async function loadPdf(data: Uint8Array): Promise<{
  pdf: PDFDocumentProxy;
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
}> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({
    // pdfjs transfers ownership of this buffer to its worker and detaches it,
    // so a second getDocument() on the same bytes fails with "Cannot transfer
    // object of unsupported type". The bench reads truth and rasterizes from
    // one in-memory copy, so hand each call its own.
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: assetDir("standard_fonts"),
    wasmUrl: assetDir("wasm"),
    cMapUrl: assetDir("cmaps"),
    cMapPacked: true,
    iccUrl: assetDir("iccs"),
    disableFontFace: true,
  }).promise;
  return { pdf, pdfjs };
}

function countShownGlyphs(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, entry) => sum + countShownGlyphs(entry), 0);
  }
  if (value && typeof value === "object" && "unicode" in value) return 1;
  if (typeof value === "string") return value.length;
  return 0;
}

/**
 * Distinguish real painted text from an invisible OCR layer sitting under a
 * scan. Render mode 3/7 is "no fill, no stroke" — the classic hidden-OCR
 * signature. A hidden layer is worthless as an accuracy oracle: it *is* someone
 * else's OCR, so agreeing with it proves nothing.
 */
async function textVisibility(
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"),
  page: PDFPageProxy
): Promise<NativeTextVisibility> {
  const operators = await page.getOperatorList();
  const textOps = new Set([
    pdfjs.OPS.showText,
    pdfjs.OPS.showSpacedText,
    pdfjs.OPS.nextLineShowText,
    pdfjs.OPS.nextLineSetSpacingShowText,
  ]);
  let mode = 0;
  let visible = 0;
  let hidden = 0;

  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i];
    const args = operators.argsArray[i];
    if (op === pdfjs.OPS.setTextRenderingMode) {
      mode = Number(args?.[0] ?? 0);
      continue;
    }
    if (!textOps.has(op)) continue;
    const glyphs = Math.max(1, countShownGlyphs(args));
    if (mode === 3 || mode === 7) hidden += glyphs;
    else visible += glyphs;
  }

  const total = visible + hidden;
  if (total === 0) return "none";
  const hiddenRatio = hidden / total;
  if (hiddenRatio >= 0.9) return "hidden";
  if (hiddenRatio <= 0.1) return "visible";
  return "mixed";
}

export async function readTruth(data: Uint8Array): Promise<PdfTruth> {
  const { pdf, pdfjs } = await loadPdf(data);
  try {
    const pages: TruthPage[] = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const [content, visibility] = await Promise.all([
          page.getTextContent(),
          textVisibility(pdfjs, page),
        ]);
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        pages.push({
          pageNumber: i,
          width: viewport.width,
          height: viewport.height,
          text,
          visibility,
        });
      } finally {
        page.cleanup();
      }
    }

    const visiblePages = pages.filter((p) => p.visibility === "visible");
    const withWords = visiblePages.filter((p) => p.text.split(/\s+/).length >= 20);
    return {
      pageCount: pdf.numPages,
      pages,
      visibleTextRatio: pages.length ? visiblePages.length / pages.length : 0,
      // Oracle only when most pages carry real, substantial painted text.
      usableAsOracle:
        pages.length > 0 && withWords.length / pages.length >= 0.6,
    };
  } finally {
    await pdf.destroy();
  }
}

export interface RasterPage {
  pageNumber: number;
  png: Buffer;
  width: number;
  height: number;
}

/** Rasterize pages at production's scale, for the per-page OCR variant. */
export async function rasterize(
  data: Uint8Array,
  pageNumbers?: number[]
): Promise<RasterPage[]> {
  const { pdf } = await loadPdf(data);
  try {
    const canvasFactory = pdf.canvasFactory as {
      create: (w: number, h: number) => {
        canvas: { toBuffer: (mime: "image/png") => Buffer };
        context: CanvasRenderingContext2D;
      };
      destroy: (canvas: unknown) => void;
    };
    const targets =
      pageNumbers ?? Array.from({ length: pdf.numPages }, (_, i) => i);
    const out: RasterPage[] = [];

    for (const pageNumber of targets) {
      const page = await pdf.getPage(pageNumber + 1);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(TARGET_WIDTH / base.width, MAX_SCALE);
        const viewport = page.getViewport({ scale });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        const cc = canvasFactory.create(width, height);
        try {
          cc.context.fillStyle = "#ffffff";
          cc.context.fillRect(0, 0, width, height);
          await page.render({
            canvas: cc.canvas as unknown as HTMLCanvasElement,
            viewport,
          }).promise;
          out.push({
            pageNumber,
            png: cc.canvas.toBuffer("image/png"),
            width,
            height,
          });
        } finally {
          canvasFactory.destroy(cc);
        }
      } finally {
        page.cleanup();
      }
    }
    return out;
  } finally {
    await pdf.destroy();
  }
}

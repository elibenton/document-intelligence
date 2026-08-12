"use node";

/**
 * Canonical PDF derivative renderer. Each page is opened once to produce a
 * server-side PNG (when missing) and native PDF text geometry (when present).
 * Scanned pages naturally yield no native text, so their Interfaze OCR rows
 * remain canonical. Versioned commits make upgrades resumable without
 * re-rasterizing pages whose pixels already exist.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { createRequire } from "node:module";
import path from "node:path";
import { RENDERER_VERSION } from "./rendererConfig";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
} from "pdfjs-dist";

const TARGET_WIDTH = 1600;
const MAX_SCALE = 4;
const TIME_BUDGET_MS = 7 * 60 * 1000;
const MAX_TEXT_ITEMS_PER_PAGE = 6000;

type NativeBlock = {
  blockId: string;
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  words: {
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
  }[];
};

type NativeTextVisibility = "visible" | "hidden" | "mixed" | "none";

type PdfTextItem = {
  str: string;
  dir: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
  hasEOL: boolean;
};

function splitNativeWords(
  text: string,
  bbox: NativeBlock["bbox"]
): NativeBlock["words"] {
  const matches = [...text.matchAll(/\S+/gu)];
  const length = Math.max(1, text.length);
  return matches.map((match) => {
    const start = match.index ?? 0;
    const value = match[0];
    return {
      text: value,
      bbox: {
        x: bbox.x + bbox.width * (start / length),
        y: bbox.y,
        width: bbox.width * (value.length / length),
        height: bbox.height,
      },
    };
  });
}

function countShownGlyphs(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + countShownGlyphs(entry), 0);
  }
  if (value && typeof value === "object" && "unicode" in value) return 1;
  if (typeof value === "string") return value.length;
  return 0;
}

/** Detect hidden OCR text from the PDF operators, not from extraction alone. */
async function nativeTextVisibility(
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"),
  page: PDFPageProxy
): Promise<NativeTextVisibility> {
  const operators = await page.getOperatorList();
  let renderingMode = 0;
  let visibleGlyphs = 0;
  let hiddenGlyphs = 0;
  const textOperators = new Set([
    pdfjs.OPS.showText,
    pdfjs.OPS.showSpacedText,
    pdfjs.OPS.nextLineShowText,
    pdfjs.OPS.nextLineSetSpacingShowText,
  ]);

  for (let index = 0; index < operators.fnArray.length; index++) {
    const operator = operators.fnArray[index];
    const args = operators.argsArray[index];
    if (operator === pdfjs.OPS.setTextRenderingMode) {
      renderingMode = Number(args?.[0] ?? 0);
      continue;
    }
    if (!textOperators.has(operator)) continue;
    const glyphs = Math.max(1, countShownGlyphs(args));
    if (renderingMode === 3 || renderingMode === 7) hiddenGlyphs += glyphs;
    else visibleGlyphs += glyphs;
  }

  const total = visibleGlyphs + hiddenGlyphs;
  if (total === 0) return "none";
  const hiddenRatio = hiddenGlyphs / total;
  if (hiddenRatio >= 0.9) return "hidden";
  if (hiddenRatio <= 0.1) return "visible";
  return "mixed";
}

function pdfjsAssetDir(
  dir: "standard_fonts" | "wasm" | "cmaps" | "iccs"
): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("pdfjs-dist/package.json");
    return path.join(path.dirname(pkg), dir) + path.sep;
  } catch {
    return undefined;
  }
}

function bounded(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Reproduce PDF.js text-layer placement in the raster viewport's pixels. */
async function extractNativeBlocks(
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"),
  page: PDFPageProxy,
  viewport: PageViewport,
  pageNumber: number
): Promise<{ blocks: NativeBlock[]; geometryScore: number }> {
  const content = await page.getTextContent();
  const styles = content.styles as Record<
    string,
    { ascent?: number; descent?: number; vertical?: boolean }
  >;
  const blocks: NativeBlock[] = [];
  let considered = 0;
  let rejected = 0;
  let suspicious = 0;

  for (const raw of content.items.slice(0, MAX_TEXT_ITEMS_PER_PAGE)) {
    if (!("str" in raw)) continue;
    const item = raw as PdfTextItem;
    const text = item.str.trim();
    if (!text || item.transform.length < 6) continue;
    considered++;

    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    let angle = Math.atan2(tx[1], tx[0]);
    const style = styles[item.fontName];
    if (style?.vertical) angle += Math.PI / 2;

    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (!Number.isFinite(fontHeight) || fontHeight <= 0) {
      rejected++;
      continue;
    }
    const ascent = style?.ascent
      ? style.ascent * fontHeight
      : style?.descent
        ? (1 + style.descent) * fontHeight
        : fontHeight;

    const left = tx[4] + ascent * Math.sin(angle);
    const top = tx[5] - ascent * Math.cos(angle);
    const horizontalWidth = Math.abs(item.width * viewport.scale);
    const rotatedWidth =
      Math.abs(horizontalWidth * Math.cos(angle)) +
      Math.abs(fontHeight * Math.sin(angle));
    const rotatedHeight =
      Math.abs(horizontalWidth * Math.sin(angle)) +
      Math.abs(fontHeight * Math.cos(angle));

    const toleranceX = Math.max(2, viewport.width * 0.01);
    const toleranceY = Math.max(2, viewport.height * 0.01);
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(rotatedWidth) ||
      !Number.isFinite(rotatedHeight) ||
      left < -toleranceX ||
      top < -toleranceY ||
      left + rotatedWidth > viewport.width + toleranceX ||
      top + rotatedHeight > viewport.height + toleranceY
    ) {
      rejected++;
      continue;
    }

    const x = bounded(left, 0, viewport.width);
    const y = bounded(top, 0, viewport.height);
    const width = bounded(rotatedWidth, 0, viewport.width - x);
    const height = bounded(rotatedHeight, 0, viewport.height - y);
    if (width < 0.25 || height < 0.25) {
      rejected++;
      continue;
    }

    if (
      (x <= 0.5 && width <= viewport.width * 0.01) ||
      (width >= viewport.width * 0.9 && text.length <= 4) ||
      height >= viewport.height * 0.25
    ) {
      suspicious++;
    }

    const bbox = { x, y, width, height };
    blocks.push({
      blockId: `p${pageNumber}_pdf_${blocks.length}`,
      text,
      bbox,
      words: splitNativeWords(item.str, bbox),
    });
  }
  const denominator = Math.max(1, considered);
  const geometryScore = Math.max(
    0,
    Math.min(1, 1 - rejected / denominator - (suspicious / denominator) * 2)
  );
  return { blocks, geometryScore };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const renderBatch = internalAction({
  args: {
    documentId: v.id("documents"),
    startPage: v.number(),
  },
  handler: async (ctx, args) => {
    let pdf: PDFDocumentProxy | undefined;
    try {
      const doc = await ctx.runQuery(internal.pageImages.docForRender, {
        documentId: args.documentId,
      });
      if (!doc) return null;
      if (doc.mimeType !== "application/pdf" && doc.mediaType !== "pdf") {
        return null;
      }

      const blob = await ctx.storage.get(doc.storageId);
      if (!blob) throw new Error("Original PDF is missing from storage");
      const data = new Uint8Array(await blob.arrayBuffer());
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdf = await pdfjs.getDocument({
        data,
        isEvalSupported: false,
        useSystemFonts: false,
        standardFontDataUrl: pdfjsAssetDir("standard_fonts"),
        wasmUrl: pdfjsAssetDir("wasm"),
        cMapUrl: pdfjsAssetDir("cmaps"),
        cMapPacked: true,
        iccUrl: pdfjsAssetDir("iccs"),
        disableFontFace: true,
      }).promise;

      await ctx.runMutation(internal.pageImages.beginRender, {
        documentId: args.documentId,
        expectedPages: pdf.numPages,
        rendererVersion: RENDERER_VERSION,
      });

      const canvasFactory = pdf.canvasFactory as {
        create: (width: number, height: number) => {
          canvas: { toBuffer: (mime: "image/png") => Buffer };
          context: CanvasRenderingContext2D;
        };
        destroy: (canvas: unknown) => void;
      };
      const existingVersions = new Map(
        (
          await ctx.runQuery(internal.pageImages.renderedPageVersions, {
            documentId: args.documentId,
          })
        ).map((row) => [row.pageNumber, row.rendererVersion])
      );

      const deadline = Date.now() + TIME_BUDGET_MS;
      let pageIndex = args.startPage;
      for (; pageIndex < pdf.numPages; pageIndex++) {
        if (Date.now() > deadline) break;
        if (existingVersions.get(pageIndex) === RENDERER_VERSION) continue;

        const page = await pdf.getPage(pageIndex + 1);
        try {
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(TARGET_WIDTH / base.width, MAX_SCALE);
          const viewport = page.getViewport({ scale });
          const width = Math.ceil(viewport.width);
          const height = Math.ceil(viewport.height);
          const [nativeGeometry, textVisibility] = await Promise.all([
            extractNativeBlocks(pdfjs, page, viewport, pageIndex),
            nativeTextVisibility(pdfjs, page),
          ]);

          let storageId;
          if (!existingVersions.has(pageIndex)) {
            const canvasAndContext = canvasFactory.create(width, height);
            let png: Buffer;
            try {
              const context = canvasAndContext.context;
              context.fillStyle = "#ffffff";
              context.fillRect(0, 0, width, height);
              await page.render({
                canvas: canvasAndContext.canvas as unknown as HTMLCanvasElement,
                viewport,
              }).promise;
              png = canvasAndContext.canvas.toBuffer("image/png");
            } finally {
              canvasFactory.destroy(canvasAndContext);
            }
            storageId = await ctx.storage.store(
              new Blob([new Uint8Array(png)], { type: "image/png" })
            );
          }

          await ctx.runMutation(internal.pageImages.commitPage, {
            documentId: args.documentId,
            pageNumber: pageIndex,
            storageId,
            width,
            height,
            rendererVersion: RENDERER_VERSION,
            nativeBlocks: nativeGeometry.blocks,
            nativeTextVisibility: textVisibility,
            nativeGeometryScore: nativeGeometry.geometryScore,
          });
        } finally {
          page.cleanup();
        }
      }

      if (pageIndex < pdf.numPages) {
        await ctx.scheduler.runAfter(0, internal.renderPages.renderBatch, {
          documentId: args.documentId,
          startPage: pageIndex,
        });
      } else {
        await ctx.runMutation(internal.pageImages.completeRender, {
          documentId: args.documentId,
          expectedPages: pdf.numPages,
          rendererVersion: RENDERER_VERSION,
        });
      }
      return null;
    } catch (error) {
      try {
        await ctx.runMutation(internal.pageImages.failRender, {
          documentId: args.documentId,
          rendererVersion: RENDERER_VERSION,
          error: errorMessage(error),
        });
      } catch {
        // Keep the renderer's original error as the action failure.
      }
      throw error;
    } finally {
      if (pdf) await pdf.destroy();
    }
  },
});

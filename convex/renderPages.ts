"use node";

/**
 * Native PDF text geometry extractor.
 *
 * This used to also rasterize every page to a server-side PNG. Nothing on the
 * server ever read those images — only the browser did — and producing them
 * required @napi-rs/canvas in the Convex Node runtime, where the first
 * page.render() alone spiked RSS by ~380MB and the action was repeatedly killed
 * by the platform before its own catch block could run. Pages are now drawn
 * client-side by pdf.js from the original file (see PdfPageCanvas), so this
 * action keeps only the half with a server-side consumer: the text and word
 * boxes that back search, citations, and the selectable text layer.
 *
 * That half is cheap — roughly 10ms per page, no canvas, no image storage.
 * Scanned pages naturally yield no native text, so their Interfaze OCR rows
 * remain canonical. Versioned commits keep upgrades resumable.
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

export const renderBatch = internalAction({
  args: {
    documentId: v.id("documents"),
    startPage: v.number(),
  },
  handler: async (ctx, args) => {
    let pdf: PDFDocumentProxy | undefined;
    try {
      const doc = await ctx.runQuery(internal.render.docForRender, {
        documentId: args.documentId,
      });
      if (!doc) return null;
      // DOCX derivatives come from the lightweight docx renderer. Dispatch here
      // so every scheduling path (upload, ensureRendered, retry, backfill)
      // stays media-agnostic.
      if (doc.mediaType === "docx") {
        await ctx.scheduler.runAfter(0, internal.docxRender.renderDocx, {
          documentId: args.documentId,
        });
        return null;
      }
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

      await ctx.runMutation(internal.render.beginRender, {
        documentId: args.documentId,
        expectedPages: pdf.numPages,
        rendererVersion: RENDERER_VERSION,
      });

      const existingVersions = new Map(
        (
          await ctx.runQuery(internal.render.renderedPageVersions, {
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
          // The geometry is expressed in the coordinate space the viewer
          // scales overlays against, which is why the viewport is still built
          // at TARGET_WIDTH even though no pixels are produced from it.
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(TARGET_WIDTH / base.width, MAX_SCALE);
          const viewport = page.getViewport({ scale });
          const [nativeGeometry, textVisibility] = await Promise.all([
            extractNativeBlocks(pdfjs, page, viewport, pageIndex),
            nativeTextVisibility(pdfjs, page),
          ]);

          await ctx.runMutation(internal.render.commitPage, {
            documentId: args.documentId,
            pageNumber: pageIndex,
            width: Math.ceil(viewport.width),
            height: Math.ceil(viewport.height),
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
        await ctx.runMutation(internal.render.completeRender, {
          documentId: args.documentId,
          expectedPages: pdf.numPages,
          rendererVersion: RENDERER_VERSION,
        });
      }
      return null;
    } catch (error) {
      // With no pool retrying behind this action, its own throw is the
      // verdict. Record it (mirroring docxRender), then rethrow so the
      // platform logs keep the original stack. A platform kill skips this
      // catch entirely — ensureRendered's stale-heartbeat re-kick covers it.
      try {
        await ctx.runMutation(internal.render.failRender, {
          documentId: args.documentId,
          rendererVersion: RENDERER_VERSION,
          error: error instanceof Error ? error.message : String(error),
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

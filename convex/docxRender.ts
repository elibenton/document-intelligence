"use node";

/**
 * DOCX derivative renderer — the viewer's counterpart to renderPages.ts.
 *
 * Interfaze reads DOCX natively (native docx support shipped 2026-08-12, with
 * bounding boxes and confidence like a PDF), so this renderer exists only to
 * give the reader page images and native text geometry. It does not call any
 * provider and is never on the analysis critical path.
 *
 * "Lightweight" is a design constraint, not an aspiration: a minimal ZIP reader
 * over Node's zlib, a regex pass over `word/document.xml`, and a text layout on
 * the canvas we already ship for pdf.js. No new dependencies, no headless
 * office suite, no styling fidelity beyond headings, lists and page breaks.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { inflateRawSync } from "node:zlib";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { RENDERER_VERSION } from "./rendererConfig";
import {
  layoutDocument,
  parseDocumentXml,
  type MeasureText,
} from "./docx";

const MAX_DOCUMENT_XML_BYTES = 40_000_000;
const MAX_PAGES = 2_000;

const FONT_FAMILY = GlobalFonts.families.some((f) => f.family === "DejaVu Sans")
  ? "DejaVu Sans"
  : "sans-serif";

function fontSpec(fontPx: number, bold: boolean) {
  return `${bold ? "bold " : ""}${fontPx}px ${FONT_FAMILY}`;
}

/**
 * Read one entry out of a ZIP archive.
 *
 * Only what DOCX actually uses: the end-of-central-directory record, stored and
 * deflated entries. ZIP64 and encrypted archives are rejected rather than
 * silently mis-read.
 */
export function readZipEntry(data: Uint8Array, name: string): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const maxComment = Math.min(data.length, 66_000);
  let eocd = -1;
  for (let offset = data.length - 22; offset >= data.length - maxComment && offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .docx file (no ZIP directory)");

  const entryCount = view.getUint16(eocd + 10, true);
  let directory = view.getUint32(eocd + 16, true);
  if (directory === 0xffffffff || entryCount === 0xffff) {
    throw new Error("ZIP64 .docx files are not supported by the renderer");
  }

  const target = new TextEncoder().encode(name);
  for (let index = 0; index < entryCount; index++) {
    if (view.getUint32(directory, true) !== 0x02014b50) {
      throw new Error("Corrupt .docx central directory");
    }
    const flags = view.getUint16(directory + 8, true);
    const method = view.getUint16(directory + 10, true);
    const compressedSize = view.getUint32(directory + 20, true);
    const nameLength = view.getUint16(directory + 28, true);
    const extraLength = view.getUint16(directory + 30, true);
    const commentLength = view.getUint16(directory + 32, true);
    const localOffset = view.getUint32(directory + 42, true);
    const nameBytes = data.subarray(directory + 46, directory + 46 + nameLength);

    const matches =
      nameLength === target.length &&
      target.every((byte, position) => nameBytes[position] === byte);
    if (matches) {
      if (flags & 0x1) throw new Error("Encrypted .docx files are not supported");
      if (view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error("Corrupt .docx local header");
      }
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const body = data.subarray(start, start + compressedSize);
      if (method === 0) return body;
      if (method !== 8) {
        throw new Error(`Unsupported .docx compression method ${method}`);
      }
      return new Uint8Array(inflateRawSync(body, { maxOutputLength: MAX_DOCUMENT_XML_BYTES }));
    }
    directory += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`.docx is missing ${name}`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const renderDocx = internalAction({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const doc = await ctx.runQuery(internal.pageImages.docForRender, {
        documentId: args.documentId,
      });
      if (!doc || doc.mediaType !== "docx") return null;

      const blob = await ctx.storage.get(doc.storageId);
      if (!blob) throw new Error("Original .docx is missing from storage");
      const data = new Uint8Array(await blob.arrayBuffer());
      const xml = new TextDecoder().decode(
        readZipEntry(data, "word/document.xml")
      );

      // One shared canvas context for measurement keeps layout and drawing on
      // exactly the same font metrics.
      const measureCanvas = createCanvas(8, 8).getContext("2d");
      const measure: MeasureText = (text, fontPx, bold) => {
        measureCanvas.font = fontSpec(fontPx, bold);
        return measureCanvas.measureText(text).width;
      };

      const paragraphs = parseDocumentXml(xml);
      const pages = layoutDocument(paragraphs, measure);
      if (pages.length > MAX_PAGES) {
        throw new Error(
          `.docx laid out to ${pages.length} pages, above the ${MAX_PAGES}-page renderer limit`
        );
      }

      await ctx.runMutation(internal.pageImages.beginRender, {
        documentId: args.documentId,
        expectedPages: pages.length,
        rendererVersion: RENDERER_VERSION,
      });

      const existingVersions = new Map(
        (
          await ctx.runQuery(internal.pageImages.renderedPageVersions, {
            documentId: args.documentId,
          })
        ).map((row) => [row.pageNumber, row.rendererVersion])
      );

      for (const [pageNumber, page] of pages.entries()) {
        if (existingVersions.get(pageNumber) === RENDERER_VERSION) continue;
        // No raster is produced. Pages are drawn client-side by pdf.js, and
        // commitPage only ever *deletes* a storageId handed to it — so the PNG
        // this used to store was orphaned in storage on every first render,
        // unreferenced and unreachable by the delete cascade. What DOCX
        // rendering actually delivers is nativeBlocks, which needs the layout,
        // not the pixels.
        await ctx.runMutation(internal.pageImages.commitPage, {
          documentId: args.documentId,
          pageNumber,
          width: page.width,
          height: page.height,
          rendererVersion: RENDERER_VERSION,
          nativeBlocks: page.lines.map((line, index) => ({
            blockId: `p${pageNumber}_docx_${index}`,
            text: line.text,
            bbox: {
              x: line.x,
              y: line.y,
              width: line.width,
              height: line.height,
            },
            words: line.words.map((word) => ({
              text: word.text,
              bbox: {
                x: word.x,
                y: line.y,
                width: word.width,
                height: line.height,
              },
            })),
          })),
          // DOCX text is authored, never a scan behind an invisible OCR layer.
          nativeTextVisibility: page.lines.length > 0 ? "visible" : "none",
          nativeGeometryScore: 1,
        });
      }

      await ctx.runMutation(internal.pageImages.completeRender, {
        documentId: args.documentId,
        expectedPages: pages.length,
        rendererVersion: RENDERER_VERSION,
      });
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
    }
  },
});

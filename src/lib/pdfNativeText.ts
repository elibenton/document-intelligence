import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  buildNativePageBlocks,
  summarizePageOps,
  type NativeBox,
  type NativeTextItem,
} from "./pdfNativeItems";

/**
 * Extract a digital-native PDF's own text layer, with geometry, in the
 * browser — the free alternative to paying Interfaze to OCR text the file
 * already carries. The result is committed through
 * `api.nativeText.ingestNativePages`, and a complete extraction lets the
 * pipeline skip both the file-in understanding call and the OCR task
 * (convex/processingStages.ts).
 *
 * All-or-nothing on purpose: one page whose text is a scanner's invisible
 * OCR underlay, sits beneath a page-sized raster, or is an image with no
 * text at all means vision OCR is still required — so the whole document
 * takes today's path rather than committing a half-native layer. A page
 * with no text and no image is a genuinely blank page and stays eligible.
 */

export interface NativePageExtract {
  /** 0-indexed, matching `pages.pageNumber`. */
  pageNumber: number;
  text: string;
  /** Scale-1 viewport dimensions, in PDF points — the blocks' coordinate space. */
  width: number;
  height: number;
  visibility: "visible" | "none";
  geometryScore: number;
  blocks: {
    blockId: string;
    text: string;
    bbox?: NativeBox;
    words?: { text: string; bbox?: NativeBox }[];
  }[];
}

/** What the PDF file itself declares — Info title/author and the outline.
 * Raw strings; the server junk-filters and sanitizes at commit
 * (convex/pdfNativeMetadata.ts, sanitizeTableOfContents). */
export interface NativePdfMetadata {
  title?: string;
  author?: string;
  tableOfContents?: { title: string; level: number; page: number }[];
}

export interface NativePdfExtract {
  pageCount: number;
  pages: NativePageExtract[];
  metadata?: NativePdfMetadata;
}

const MAX_OUTLINE_ENTRIES = 500;
const MAX_OUTLINE_DEPTH = 4;

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

/**
 * The PDF's authored outline (bookmarks) as a flat table of contents, with
 * each destination resolved to its 1-based page. Entries whose destination
 * cannot be resolved (external links, dangling refs) are skipped; the level
 * ladder is re-normalized server-side.
 */
async function outlineToToc(pdf: {
  getOutline(): Promise<OutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}): Promise<NativePdfMetadata["tableOfContents"]> {
  const outline = await pdf.getOutline();
  if (!outline || outline.length === 0) return undefined;
  const entries: { title: string; level: number; page: number }[] = [];
  const walk = async (nodes: OutlineNode[], level: number) => {
    for (const node of nodes) {
      if (entries.length >= MAX_OUTLINE_ENTRIES) return;
      const title = (node.title ?? "").trim();
      const dest =
        typeof node.dest === "string"
          ? await pdf.getDestination(node.dest)
          : node.dest;
      if (title && Array.isArray(dest) && dest[0]) {
        try {
          entries.push({
            title,
            level,
            page: (await pdf.getPageIndex(dest[0])) + 1,
          });
        } catch {
          // Destination points outside the document; skip the entry.
        }
      }
      if (node.items?.length && level < MAX_OUTLINE_DEPTH) {
        await walk(node.items, level + 1);
      }
    }
  };
  await walk(outline, 1);
  return entries.length > 0 ? entries : undefined;
}

export async function extractPdfNativeText(
  file: File
): Promise<NativePdfExtract | null> {
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc ||= pdfWorkerUrl;
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false,
      stopAtErrors: true,
    });
    const opCodes = {
      setTextRenderingMode: pdfjs.OPS.setTextRenderingMode,
      showText: pdfjs.OPS.showText,
      showSpacedText: pdfjs.OPS.showSpacedText,
      nextLineShowText: pdfjs.OPS.nextLineShowText,
      nextLineSetSpacingShowText: pdfjs.OPS.nextLineSetSpacingShowText,
      paintImageXObject: pdfjs.OPS.paintImageXObject,
      paintImageMaskXObject: pdfjs.OPS.paintImageMaskXObject,
      transform: pdfjs.OPS.transform,
      save: pdfjs.OPS.save,
      restore: pdfjs.OPS.restore,
    };

    try {
      const pdf = await loadingTask.promise;
      try {
        const pages: NativePageExtract[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          try {
            const viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            const items: NativeTextItem[] = content.items.flatMap((item) =>
              "str" in item && item.str.trim().length > 0
                ? [{ str: item.str, transform: item.transform, width: item.width }]
                : []
            );

            // The operator list is what separates painted text from a
            // scanner's invisible underlay — getTextContent returns both
            // alike. It is also the expensive call, so it runs at most once
            // per page and not at all once the document is disqualified.
            const summary = summarizePageOps(
              await page.getOperatorList(),
              opCodes,
              viewport.width,
              viewport.height
            );

            if (items.length === 0) {
              // No text: blank is fine, an image-only page needs OCR.
              if (summary.hasImage) return null;
              pages.push({
                pageNumber: pageNumber - 1,
                text: "",
                width: viewport.width,
                height: viewport.height,
                visibility: "none",
                geometryScore: 1,
                blocks: [],
              });
              continue;
            }
            if (
              summary.hiddenTextRuns > 0 ||
              summary.fullPageImage ||
              summary.visibleTextRuns === 0
            ) {
              return null;
            }

            const built = buildNativePageBlocks(
              items,
              viewport.transform,
              viewport.width,
              viewport.height
            );
            pages.push({
              pageNumber: pageNumber - 1,
              text: built.text,
              width: viewport.width,
              height: viewport.height,
              visibility: "visible",
              geometryScore: built.geometryScore,
              blocks: built.blocks.map((block, index) => ({
                blockId: `p${pageNumber - 1}_n${index}`,
                text: block.text,
                bbox: block.bbox,
                words: block.words,
              })),
            });
          } finally {
            page.cleanup();
          }
        }
        if (!pages.some((page) => page.text)) return null;

        // What the file declares about itself, alongside its text: the
        // authored outline and the Info title/author. Failures here cost the
        // metadata, never the extraction.
        let metadata: NativePdfMetadata | undefined;
        try {
          const { info } = (await pdf.getMetadata()) as {
            info: { Title?: string; Author?: string };
          };
          const tableOfContents = await outlineToToc(pdf);
          const title = typeof info?.Title === "string" ? info.Title : undefined;
          const author =
            typeof info?.Author === "string" ? info.Author : undefined;
          if (title || author || tableOfContents) {
            metadata = { title, author, tableOfContents };
          }
        } catch {
          metadata = undefined;
        }
        return { pageCount: pages.length, pages, metadata };
      } finally {
        await pdf.destroy();
      }
    } catch {
      await loadingTask.destroy();
      return null;
    }
  } catch {
    // Extraction is an optimization; any failure means the OCR path runs.
    return null;
  }
}

/**
 * Split an extraction into mutation-sized batches. Word boxes dominate the
 * payload, so batches are cut by serialized size rather than page count —
 * a dense page can outweigh thirty sparse ones.
 */
const BATCH_CHAR_BUDGET = 600_000;

export function batchNativePages(
  pages: NativePageExtract[]
): NativePageExtract[][] {
  const batches: NativePageExtract[][] = [];
  let current: NativePageExtract[] = [];
  let currentSize = 0;
  for (const page of pages) {
    const size = JSON.stringify(page).length;
    if (current.length > 0 && currentSize + size > BATCH_CHAR_BUDGET) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(page);
    currentSize += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

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

export interface NativePdfExtract {
  pageCount: number;
  pages: NativePageExtract[];
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
        return { pageCount: pages.length, pages };
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

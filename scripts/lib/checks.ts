/**
 * Correctness checks for a scan result. These are the difference between
 * "the call returned" and "the output is usable": geometry violations are
 * exactly what makes viewer overlays land in the wrong place, and text
 * fidelity is the only measure here of OCR quality rather than plumbing.
 */

import type { OcrPageResult } from "../../convex/interfaze";
import type { PdfTruth } from "./pdf";

export interface GeometryReport {
  checked: number;
  violations: number;
  /** Up to 5 human-readable examples — enough to debug, short enough to log. */
  examples: string[];
  byKind: Record<string, number>;
}

const PAGE_BLEED = 0.01; // 1% — rounding at page edges is normal
const WORD_SLACK = 0.02; // 2% — word boxes can poke slightly past their line
// A purely relative slack is useless on small boxes: a 26px-tall line gets
// 0.5px of tolerance, and real OCR word boxes routinely overhang their line by
// a pixel or two on descenders. Mirror production's own tolerance floor
// (convex/renderPages.ts uses `Math.max(2, …)`).
const MIN_SLACK_PX = 2;

const slack = (dimension: number, fraction: number) =>
  Math.max(MIN_SLACK_PX, dimension * fraction);

export function checkGeometry(pages: OcrPageResult[]): GeometryReport {
  const byKind: Record<string, number> = {};
  const examples: string[] = [];
  let checked = 0;
  let violations = 0;

  const fail = (kind: string, detail: string) => {
    violations++;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (examples.length < 5) examples.push(`${kind}: ${detail}`);
  };

  for (const page of pages) {
    const { width, height } = page;
    for (const block of page.blocks) {
      checked++;
      const bbox = block.bbox;
      if (!bbox) continue;

      if (bbox.width <= 0 || bbox.height <= 0) {
        fail("zero_area", `${block.id} ${bbox.width}x${bbox.height}`);
      }

      if (typeof width === "number" && typeof height === "number") {
        const tolX = slack(width, PAGE_BLEED);
        const tolY = slack(height, PAGE_BLEED);
        if (
          bbox.x < -tolX ||
          bbox.y < -tolY ||
          bbox.x + bbox.width > width + tolX ||
          bbox.y + bbox.height > height + tolY
        ) {
          fail(
            "outside_page",
            `${block.id} box(${bbox.x.toFixed(0)},${bbox.y.toFixed(0)},${bbox.width.toFixed(0)},${bbox.height.toFixed(0)}) page ${width.toFixed(0)}x${height.toFixed(0)}`
          );
        }
      }

      if (
        block.confidence !== undefined &&
        (block.confidence < 0 || block.confidence > 1)
      ) {
        fail("confidence_range", `${block.id} ${block.confidence}`);
      }

      let previousRight = -Infinity;
      for (const word of block.words ?? []) {
        if (word.confidence !== undefined && (word.confidence < 0 || word.confidence > 1)) {
          fail("word_confidence_range", `${block.id} "${word.text}" ${word.confidence}`);
        }
        const wb = word.bbox;
        if (!wb) continue;

        const slackX = slack(bbox.width, WORD_SLACK);
        const slackY = slack(bbox.height, WORD_SLACK);
        if (
          wb.x < bbox.x - slackX ||
          wb.y < bbox.y - slackY ||
          wb.x + wb.width > bbox.x + bbox.width + slackX ||
          wb.y + wb.height > bbox.y + bbox.height + slackY
        ) {
          fail("word_outside_line", `${block.id} "${word.text}"`);
        }
        // Left-to-right monotonic within a line. Overlap is fine (kerning,
        // ligatures); a word starting left of the previous word's start is not.
        if (wb.x < previousRight - wb.width) {
          fail("word_order", `${block.id} "${word.text}" x=${wb.x.toFixed(0)}`);
        }
        previousRight = Math.max(previousRight, wb.x);
      }
    }
  }

  return { checked, violations, examples, byKind };
}

// ---------------------------------------------------------------------------
// Text fidelity against the native text layer.
// ---------------------------------------------------------------------------

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents — OCR/native often differ here
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // punctuation is not a fair comparison
    .split(/\s+/)
    .filter(Boolean);
}

/** Multiset intersection size — order-independent, repeat-aware. */
function overlap(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const n = counts.get(t) ?? 0;
    if (n > 0) {
      shared++;
      counts.set(t, n - 1);
    }
  }
  return shared;
}

export interface FidelityReport {
  applicable: boolean;
  reason?: string;
  /** shared / max(native, ocr) across the whole document, 0-1. */
  ratio: number;
  nativeWords: number;
  ocrWords: number;
  /** Pages sorted worst-first, for eyeballing where OCR fell down. */
  worstPages: { pageNumber: number; ratio: number; native: number; ocr: number }[];
}

export function checkTextFidelity(
  pages: OcrPageResult[],
  truth: PdfTruth
): FidelityReport {
  if (!truth.usableAsOracle) {
    return {
      applicable: false,
      reason:
        "no usable native text layer (scanned, or the text layer is itself hidden OCR)",
      ratio: 0,
      nativeWords: 0,
      ocrWords: 0,
      worstPages: [],
    };
  }

  const perPage: FidelityReport["worstPages"] = [];
  let totalShared = 0;
  let totalNative = 0;
  let totalOcr = 0;

  for (const truthPage of truth.pages) {
    // Only pages with genuinely painted text are fair comparisons.
    if (truthPage.visibility !== "visible") continue;
    const native = tokens(truthPage.text);
    if (native.length < 20) continue;
    const ocr = tokens(
      pages.find((p) => p.pageNumber === truthPage.pageNumber)?.text ?? ""
    );
    const shared = overlap(native, ocr);
    totalShared += shared;
    totalNative += native.length;
    totalOcr += ocr.length;
    perPage.push({
      pageNumber: truthPage.pageNumber,
      ratio: shared / Math.max(native.length, ocr.length, 1),
      native: native.length,
      ocr: ocr.length,
    });
  }

  if (perPage.length === 0) {
    return {
      applicable: false,
      reason: "no comparable pages",
      ratio: 0,
      nativeWords: 0,
      ocrWords: 0,
      worstPages: [],
    };
  }

  return {
    applicable: true,
    ratio: totalShared / Math.max(totalNative, totalOcr, 1),
    nativeWords: totalNative,
    ocrWords: totalOcr,
    worstPages: perPage.sort((a, b) => a.ratio - b.ratio).slice(0, 5),
  };
}

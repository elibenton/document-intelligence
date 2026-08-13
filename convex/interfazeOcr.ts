/**
 * OCR precontext -> stored pages, blocks and geometry.
 *
 * Pure data transforms over the shape Interfaze returns: no SDK calls, no
 * network, no node built-ins. Kept apart from the client so the pagination and
 * coordinate-scaling rules — the subtlest logic in the pipeline, and the part
 * with real regression history — can be read and unit-tested on their own.
 */

import type { Precontext } from "interfaze";

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InterfazeWord {
  text: string;
  bbox?: Bbox;
  confidence?: number;
}

/** Flattened block for storage (same shape the ingest mutations expect). */
export interface InterfazeBlock {
  id: string;
  block_type: string;
  text: string;
  page: number;
  bbox?: Bbox;
  confidence?: number;
  words?: InterfazeWord[];
}

export interface InterfazePageDimension {
  page: number;
  width: number;
  height: number;
}

/** One page's OCR result, normalized for ingest. */
export interface OcrPageResult {
  pageNumber: number; // 0-indexed
  text: string;
  width?: number;
  height?: number;
  blocks: InterfazeBlock[];
}

// ---------------------------------------------------------------------------
// OCR precontext → blocks
//
// Interfaze's OCR result (https://interfaze.ai/docs/vision/ocr) is nested
// sections → lines → words, each line/word carrying `bounds` (four corner
// points + width/height) and a confidence (`average_confidence` on lines,
// `confidence` on words), plus per-image `width`/`height`. We flatten that into
// one line-level block per line (with its words) for the viewer's overlays.
// ---------------------------------------------------------------------------

interface OcrPoint {
  x?: number;
  y?: number;
}
interface OcrBounds {
  top_left?: OcrPoint;
  top_right?: OcrPoint;
  bottom_right?: OcrPoint;
  bottom_left?: OcrPoint;
  width?: number;
  height?: number;
}
interface OcrWord {
  text?: string;
  bounds?: OcrBounds;
  confidence?: number;
}
interface OcrLine {
  text?: string;
  bounds?: OcrBounds;
  average_confidence?: number;
  words?: OcrWord[];
}
interface OcrSection {
  text?: string;
  lines?: OcrLine[];
}
interface OcrResult {
  extracted_text?: string;
  sections?: OcrSection[];
  width?: number;
  height?: number;
  total_pages?: number;
}

function boundsToBbox(
  bounds: OcrBounds | undefined,
  scaleX = 1,
  scaleY = 1
): Bbox | undefined {
  if (!bounds) return undefined;
  const points = [
    bounds.top_left,
    bounds.top_right,
    bounds.bottom_right,
    bounds.bottom_left,
  ].filter(
    (p): p is Required<OcrPoint> =>
      typeof p?.x === "number" && typeof p?.y === "number"
  );
  if (points.length < 3) return undefined;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) * scaleX;
  const y = Math.min(...ys) * scaleY;
  return {
    x,
    y,
    width: (Math.max(...xs) - Math.min(...xs)) * scaleX,
    height: (Math.max(...ys) - Math.min(...ys)) * scaleY,
  };
}

function sectionCoordinateMax(section: OcrSection) {
  let maxX = 0;
  let maxY = 0;
  const include = (bounds: OcrBounds | undefined) => {
    for (const point of [
      bounds?.top_left,
      bounds?.top_right,
      bounds?.bottom_right,
      bounds?.bottom_left,
    ]) {
      if (typeof point?.x === "number") maxX = Math.max(maxX, point.x);
      if (typeof point?.y === "number") maxY = Math.max(maxY, point.y);
    }
  };
  for (const line of section.lines ?? []) {
    include(line.bounds);
    for (const word of line.words ?? []) include(word.bounds);
  }
  return { maxX, maxY };
}

/** OCR may rasterize a rotated axis at an integer multiple of page pixels. */
function coordinateScale(maxCoordinate: number, pageDimension?: number) {
  if (!pageDimension || maxCoordinate <= pageDimension * 1.1) return 1;
  return 1 / Math.max(1, Math.ceil(maxCoordinate / pageDimension - 0.05));
}

function collectOcrResults(precontext: Precontext[]): OcrResult[] {
  return precontext
    .filter(
      (p) =>
        p.name === "ocr" && typeof p.result === "object" && p.result !== null
    )
    .map((p) => p.result as OcrResult);
}

/**
 * Fingerprint an OCR result by shape and content, cheaply.
 *
 * Only used to recognize *repeats* of the same result, so it does not need to
 * be collision-proof — it needs to be identical for identical payloads and
 * different for genuinely different pages. Section text lengths plus a short
 * head of the first section separate real pages reliably.
 */
function ocrFingerprint(ocr: OcrResult): string {
  const sections = ocr.sections ?? [];
  return [
    ocr.width,
    ocr.height,
    ocr.total_pages,
    sections.length,
    sections.map((s) => (s.text ?? "").length).join("."),
    (sections[0]?.text ?? "").slice(0, 120),
  ].join("|");
}

/**
 * Drop repeated OCR results.
 *
 * A single completion can carry the *same* whole-document OCR result more than
 * once (observed: two identical entries for a 3-page and a 12-page PDF). The
 * per-page branch below reads each entry as one page, so leaving the repeats in
 * merges every page's text onto page 0, duplicates it onto page 1, and leaves
 * the rest blank — with page geometry scaled to the full stacked height. That
 * shipped, and it scored 6.8% text fidelity against a document's own embedded
 * text layer where the deduplicated path scores 96.5%.
 */
function dedupeOcrResults(ocrs: OcrResult[]): OcrResult[] {
  if (ocrs.length < 2) return ocrs;
  const seen = new Set<string>();
  const unique: OcrResult[] = [];
  for (const ocr of ocrs) {
    const key = ocrFingerprint(ocr);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ocr);
  }
  return unique;
}

/**
 * Normalize the OCR precontext into per-page groups.
 *
 * Whole PDFs arrive either as one OCR result per page, or as a single result
 * with one section per page. Section bounds are page-local. Rotated source
 * pages may be processed at an integer multiple along one axis, so each page
 * records the scale needed to return to its declared page dimensions.
 *
 * Pagination is inferred, not reported, so each branch is guarded: repeats are
 * removed first, and the per-result branch is only trusted when the entry count
 * actually matches the reported page count.
 */
function ocrToPages(
  input: OcrResult[]
): {
  sections: OcrSection[];
  width?: number;
  height?: number;
  scaleX: number;
  scaleY: number;
}[] {
  const ocrs = dedupeOcrResults(input);
  if (ocrs.length === 0) return [];
  const total = ocrs.find((o) => typeof o.total_pages === "number")
    ?.total_pages;

  // One entry per page — but only when the count agrees with the document.
  // A mismatch means these entries are not pages, and treating them as pages
  // is what produced the duplication bug above.
  if (ocrs.length > 1 && (total === undefined || ocrs.length === total)) {
    return ocrs.map((o) => {
      const sections = o.sections ?? [];
      const extent = sections.reduce(
        (max, section) => {
          const current = sectionCoordinateMax(section);
          return {
            maxX: Math.max(max.maxX, current.maxX),
            maxY: Math.max(max.maxY, current.maxY),
          };
        },
        { maxX: 0, maxY: 0 }
      );
      return {
        sections,
        width: o.width,
        height: o.height,
        scaleX: coordinateScale(extent.maxX, o.width),
        scaleY: coordinateScale(extent.maxY, o.height),
      };
    });
  }

  // Distinct entries that do not line up with the page count are competing
  // readings of the same document, not pages. Keep the most complete one
  // rather than the first, so a partial repeat can never win.
  const only = ocrs.reduce((best, candidate) =>
    (candidate.sections ?? []).length > (best.sections ?? []).length
      ? candidate
      : best
  );
  const sections = only.sections ?? [];
  if (total && total > 1 && sections.length === total) {
    const pageHeight =
      typeof only.height === "number" ? only.height / total : undefined;
    return sections.map((section) => {
      const extent = sectionCoordinateMax(section);
      return {
        sections: [section],
        width: only.width,
        height: pageHeight,
        scaleX: coordinateScale(extent.maxX, only.width),
        scaleY: coordinateScale(extent.maxY, pageHeight),
      };
    });
  }
  return [
    {
      sections,
      width: only.width,
      height: only.height,
      scaleX: coordinateScale(
        sections.reduce(
          (max, section) => Math.max(max, sectionCoordinateMax(section).maxX),
          0
        ),
        only.width
      ),
      scaleY: coordinateScale(
        sections.reduce(
          (max, section) => Math.max(max, sectionCoordinateMax(section).maxY),
          0
        ),
        only.height
      ),
    },
  ];
}

function ocrToBlocks(ocrs: OcrResult[]): {
  blocks: InterfazeBlock[];
  pageDimensions: InterfazePageDimension[];
  pageTexts: string[];
} {
  const blocks: InterfazeBlock[] = [];
  const pageDimensions: InterfazePageDimension[] = [];
  const pageTexts: string[] = [];

  ocrToPages(ocrs).forEach((page, pageIndex) => {
    if (typeof page.width === "number" && typeof page.height === "number") {
      pageDimensions.push({
        page: pageIndex,
        width: page.width,
        height: page.height,
      });
    }
    let lineIndex = 0;
    const lineTexts: string[] = [];
    for (const section of page.sections) {
      for (const line of section.lines ?? []) {
        const text = (line.text ?? "").trim();
        if (!text) continue;
        lineTexts.push(text);
        const words = (line.words ?? [])
          .filter((w) => (w.text ?? "").trim())
          .map((w) => ({
            text: (w.text ?? "").trim(),
            bbox: boundsToBbox(w.bounds, page.scaleX, page.scaleY),
            confidence: w.confidence,
          }));
        blocks.push({
          id: `p${pageIndex}_l${lineIndex++}`,
          block_type: "Line",
          text,
          page: pageIndex,
          bbox: boundsToBbox(line.bounds, page.scaleX, page.scaleY),
          confidence: line.average_confidence,
          words: words.length > 0 ? words : undefined,
        });
      }
    }

    // Page text is built from the very lines stored as blocks, so the two can
    // never disagree. They used to be derived independently — page text from
    // `section.text`, blocks from `section.lines` — and a real upload produced
    // 442 populated blocks alongside twelve empty pages, leaving a document
    // that rendered and highlighted but matched nothing in search.
    //
    // `section.text` is only a fallback for a section that reports text with no
    // line geometry; joining lines is otherwise strictly better, because it is
    // exactly what the reader sees highlighted.
    const sectionText = page.sections
      .map((s) => s.text ?? "")
      .filter(Boolean)
      .join("\n\n");
    pageTexts.push(lineTexts.length > 0 ? lineTexts.join("\n") : sectionText);
  });

  return { blocks, pageDimensions, pageTexts };
}

/** Normalize every OCR entry from a normal completion into stored pages. */
export function ocrPrecontextToPages(
  precontext: Precontext[]
): OcrPageResult[] {
  const ocrs = collectOcrResults(precontext);
  if (ocrs.length === 0) return [];
  const { blocks, pageDimensions, pageTexts } = ocrToBlocks(ocrs);
  const reportedPageCount = ocrs.reduce(
    (count, ocr) => Math.max(count, ocr.total_pages ?? 0),
    0
  );
  const pageCount = Math.max(
    reportedPageCount,
    pageTexts.length,
    ...blocks.map((block) => block.page + 1),
    1
  );
  return Array.from({ length: pageCount }, (_, pageNumber) => ({
    pageNumber,
    text: (pageTexts[pageNumber] ?? "").trim(),
    width:
      pageDimensions.find((dimension) => dimension.page === pageNumber)?.width,
    height:
      pageDimensions.find((dimension) => dimension.page === pageNumber)?.height,
    blocks: blocks.filter((block) => block.page === pageNumber),
  }));
}

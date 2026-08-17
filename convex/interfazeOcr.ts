/**
 * OCR precontext -> stored pages, blocks and geometry.
 *
 * Pure data transforms over the shape Interfaze returns: no SDK calls, no
 * network, no node built-ins. Kept apart from the client so the pagination and
 * coordinate-scaling rules — the subtlest logic in the pipeline, and the part
 * with real regression history — can be read and unit-tested on their own.
 */

/**
 * One entry of the `precontext` array an Interfaze completion returns when an
 * internal specialist ran (OCR, STT, web search, …). Mirrors the wire shape;
 * owned here since the app no longer depends on the `interfaze` SDK.
 */
export interface Precontext {
  name: string;
  result: unknown;
}

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

function sectionCoordinateBounds(section: OcrSection) {
  let maxX = 0;
  let maxY = 0;
  let minY = Infinity;
  const include = (bounds: OcrBounds | undefined) => {
    for (const point of [
      bounds?.top_left,
      bounds?.top_right,
      bounds?.bottom_right,
      bounds?.bottom_left,
    ]) {
      if (typeof point?.x === "number") maxX = Math.max(maxX, point.x);
      if (typeof point?.y === "number") {
        maxY = Math.max(maxY, point.y);
        minY = Math.min(minY, point.y);
      }
    }
  };
  for (const line of section.lines ?? []) {
    include(line.bounds);
    for (const word of line.words ?? []) include(word.bounds);
  }
  return { maxX, maxY, minY: Number.isFinite(minY) ? minY : 0 };
}

interface PageGroup {
  sections: OcrSection[];
  width?: number;
  height?: number;
  scaleX: number;
  scaleY: number;
}

/**
 * The page height one entry's sections are stacked at, or null if they are not
 * a stack.
 *
 * Interfaze returns a run of pages as a single entry: one section per page,
 * every section's bounds page-local, and `height` reporting the *stacked*
 * image rather than the page. The same 12-page application came back this way
 * three times, differently — six 2-page entries (height 3168), one 12-page
 * entry (height 19008), then one 11-section entry still reporting 19008. Read
 * as one page each, every page of the document lands on top of page 1: 843
 * lines with ten page headers all within y 45-130 of each other.
 *
 * The page count comes from the geometry, not from the section count. That
 * third payload is why: a stack can arrive with a page missing but still
 * declare the full height, and dividing by its 11 sections stretched every
 * page by 12/11. Flooring height by the height the coordinates occupy is the
 * largest count that still leaves each page taller than its own content, which
 * is the one invariant available here.
 *
 * Then two independent tells have to agree, because a wrong split silently
 * blanks pages and this function has the regression history for it:
 *
 *  - There must be at least two slots, and no fewer than there are sections.
 *    A page whose sections tile down it fills its own height, so it yields one
 *    slot and is left alone.
 *  - Every section must start near the top. Sections that are regions of a
 *    page begin below one another; sections that are pages each begin at their
 *    own top margin. This is what separates a stack from a sparse page whose
 *    content happens to sit in its top half.
 *
 * All three observed payloads divide out to 1584, and 1224x1584 is exactly the
 * source PDF's letter aspect — the corroboration that this arithmetic means
 * what it looks like it means.
 */
function stackedPageHeight(
  entry: OcrResult,
  sections: OcrSection[]
): number | null {
  if (sections.length < 2 || !entry.height) return null;
  const bounds = sections.map(sectionCoordinateBounds);
  const extent = Math.max(...bounds.map((b) => b.maxY));
  if (extent <= 0) return null;

  const slots = Math.floor(entry.height / extent);
  if (slots < 2 || slots < sections.length) return null;

  const pageHeight = entry.height / slots;
  return bounds.every((b) => b.minY < pageHeight / 2) ? pageHeight : null;
}

/** One OCR entry expanded into the page or pages it actually covers. */
function expandEntry(entry: OcrResult): PageGroup[] {
  const sections = entry.sections ?? [];

  const pageHeight = stackedPageHeight(entry, sections);
  if (pageHeight !== null) {
    return sections.map((section) => {
      const bounds = sectionCoordinateBounds(section);
      return {
        sections: [section],
        width: entry.width,
        height: pageHeight,
        scaleX: coordinateScale(bounds.maxX, entry.width),
        scaleY: coordinateScale(bounds.maxY, pageHeight),
      };
    });
  }

  const extent = sections.reduce(
    (max, section) => {
      const current = sectionCoordinateBounds(section);
      return {
        maxX: Math.max(max.maxX, current.maxX),
        maxY: Math.max(max.maxY, current.maxY),
      };
    },
    { maxX: 0, maxY: 0 }
  );
  return [
    {
      sections,
      width: entry.width,
      height: entry.height,
      scaleX: coordinateScale(extent.maxX, entry.width),
      scaleY: coordinateScale(extent.maxY, entry.height),
    },
  ];
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
function ocrToPages(input: OcrResult[]): PageGroup[] {
  const ocrs = dedupeOcrResults(input);
  if (ocrs.length === 0) return [];
  const total = ocrs.find((o) => typeof o.total_pages === "number")
    ?.total_pages;

  // One entry per page — but only when the count agrees with the document.
  // A mismatch means these entries are not pages, and treating them as pages
  // is what produced the duplication bug above.
  if (ocrs.length > 1 && (total === undefined || ocrs.length === total)) {
    const expanded = ocrs.map(expandEntry);
    // An entry that stacks pages tells us the payload is not one-entry-per-page
    // after all, so a sibling entry with no sections is padding rather than a
    // blank page. Left in, each one appends an empty page: the 12-section entry
    // above arrived with eleven such siblings, which would have stored 23 pages
    // for a 12-page document.
    const stacked = expanded.some((group) => group.length > 1);
    return expanded
      .filter((_, index) => !stacked || (ocrs[index].sections ?? []).length > 0)
      .flat();
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
      const bounds = sectionCoordinateBounds(section);
      return {
        sections: [section],
        width: only.width,
        height: pageHeight,
        scaleX: coordinateScale(bounds.maxX, only.width),
        scaleY: coordinateScale(bounds.maxY, pageHeight),
      };
    });
  }
  // One entry left, and `total_pages` did not vouch for a split. It may still
  // be a stack — the 12-section payload above reaches this line whenever its
  // empty siblings dedupe away — so it gets the same evidence test.
  return expandEntry(only);
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

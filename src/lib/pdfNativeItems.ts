/**
 * Native PDF text items → line blocks with word geometry.
 *
 * Pure transforms over what pdf.js `getTextContent` and `getOperatorList`
 * return: no pdf.js import, no DOM. The browser glue (pdfNativeText.ts) feeds
 * these; keeping them pure is what makes the geometry — the part with real
 * regression history on the OCR side — unit-testable on its own, the same
 * split interfazeOcr.ts makes server-side.
 *
 * All boxes are produced in the page's scale-1 viewport space: top-left
 * origin, y down, units of PDF points — the same space `pages.width/height`
 * stores, so the viewer scales them exactly as it scales OCR boxes.
 */

export interface NativeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The subset of a pdf.js `TextItem` this module reads. */
export interface NativeTextItem {
  str: string;
  /** Text-space → page-space matrix, as `getTextContent` reports it. */
  transform: number[];
  /** Advance width of the run in user-space units. */
  width: number;
}

export interface NativeWord {
  text: string;
  bbox?: NativeBox;
}

export interface NativeLineBlock {
  text: string;
  bbox?: NativeBox;
  words?: NativeWord[];
}

export interface NativePageBlocks {
  blocks: NativeLineBlock[];
  /** Lines joined with newlines, in reading order — the page's stored text. */
  text: string;
  /** Character-weighted fraction of runs whose geometry landed on the page. */
  geometryScore: number;
}

/** pdf.js `Util.transform` — compose two 6-entry matrices (m1 then m2). */
function composeTransforms(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

interface PlacedRun {
  text: string;
  /** Baseline start in viewport space. */
  originX: number;
  originY: number;
  /** Unit vector along the baseline. */
  dirX: number;
  dirY: number;
  length: number;
  fontHeight: number;
  bbox: NativeBox | null;
}

function boxFitsPage(
  box: NativeBox,
  pageWidth: number,
  pageHeight: number
): boolean {
  const toleranceX = Math.max(2, pageWidth * 0.01);
  const toleranceY = Math.max(2, pageHeight * 0.01);
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0 &&
    box.x >= -toleranceX &&
    box.y >= -toleranceY &&
    box.x + box.width <= pageWidth + toleranceX &&
    box.y + box.height <= pageHeight + toleranceY
  );
}

/**
 * Axis-aligned bounds of a run: the baseline segment swept up by the font
 * height. Exact for any rotation, since the corners are transformed rather
 * than the angle special-cased.
 */
function runBox(run: PlacedRun): NativeBox {
  // "Up" from the baseline in viewport space (y grows down).
  const upX = run.dirY;
  const upY = -run.dirX;
  const xs = [
    run.originX,
    run.originX + run.dirX * run.length,
    run.originX + upX * run.fontHeight,
    run.originX + run.dirX * run.length + upX * run.fontHeight,
  ];
  const ys = [
    run.originY,
    run.originY + run.dirY * run.length,
    run.originY + upY * run.fontHeight,
    run.originY + run.dirY * run.length + upY * run.fontHeight,
  ];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function placeRun(
  item: NativeTextItem,
  viewportTransform: number[],
  pageWidth: number,
  pageHeight: number
): PlacedRun | null {
  if (!item.str.trim()) return null;
  const tx = composeTransforms(viewportTransform, item.transform);
  const fontHeight = Math.hypot(tx[2], tx[3]);
  const scale = Math.hypot(tx[0], tx[1]);
  if (!Number.isFinite(fontHeight) || fontHeight <= 0 || scale <= 0) {
    return {
      text: item.str,
      originX: NaN,
      originY: NaN,
      dirX: 1,
      dirY: 0,
      length: 0,
      fontHeight: 0,
      bbox: null,
    };
  }
  // `item.width` is already in user-space units — the font size is folded in
  // (pdf.js's own text layer renders it at `width * viewportScale`) — so only
  // the viewport's scale applies, never the run matrix's.
  const viewportScale = Math.hypot(viewportTransform[0], viewportTransform[1]);
  const run: PlacedRun = {
    text: item.str,
    originX: tx[4],
    originY: tx[5],
    dirX: tx[0] / scale,
    dirY: tx[1] / scale,
    length: item.width * viewportScale,
    fontHeight,
    bbox: null,
  };
  const box = runBox(run);
  run.bbox = boxFitsPage(box, pageWidth, pageHeight) ? box : null;
  return run;
}

/** Distance of the run's baseline start along its own "up" axis — the line
 * key: runs on one baseline share it regardless of rotation. */
function baselineKey(run: PlacedRun): number {
  return run.originX * run.dirY - run.originY * run.dirX;
}

/** Position along the baseline direction, for in-line ordering. */
function inlineKey(run: PlacedRun): number {
  return run.originX * run.dirX + run.originY * run.dirY;
}

interface WordFragment {
  text: string;
  start: number;
  end: number;
  bbox: NativeBox | null;
}

/** Split one run into word fragments with proportional geometry. */
function runFragments(run: PlacedRun): WordFragment[] {
  const fragments: WordFragment[] = [];
  const perChar = run.text.length > 0 ? run.length / run.text.length : 0;
  const runStart = inlineKey(run);
  const pattern = /\S+/g;
  for (let match = pattern.exec(run.text); match; match = pattern.exec(run.text)) {
    const start = runStart + match.index * perChar;
    const end = runStart + (match.index + match[0].length) * perChar;
    let bbox: NativeBox | null = null;
    if (run.bbox) {
      const partial: PlacedRun = {
        ...run,
        originX: run.originX + run.dirX * match.index * perChar,
        originY: run.originY + run.dirY * match.index * perChar,
        length: match[0].length * perChar,
      };
      bbox = runBox(partial);
    }
    fragments.push({ text: match[0], start, end, bbox });
  }
  return fragments;
}

function unionBoxes(a: NativeBox, b: NativeBox): NativeBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function roundBox(box: NativeBox): NativeBox {
  const r = (value: number) => Math.round(value * 100) / 100;
  return { x: r(box.x), y: r(box.y), width: r(box.width), height: r(box.height) };
}

/**
 * Build one page's line blocks from its text items.
 *
 * Runs are grouped into lines by shared baseline (within a fraction of the
 * font height), ordered along the baseline, and split into words with
 * per-word boxes estimated proportionally within each run — the same
 * estimate the viewer itself falls back to for OCR lines without word boxes,
 * applied at the run level where it is tighter. A word split across two runs
 * (a styled fragment mid-word) is rejoined when nothing but a sub-space gap
 * separates the pieces.
 */
export function buildNativePageBlocks(
  items: NativeTextItem[],
  viewportTransform: number[],
  pageWidth: number,
  pageHeight: number
): NativePageBlocks {
  const runs = items
    .map((item) => placeRun(item, viewportTransform, pageWidth, pageHeight))
    .filter((run): run is PlacedRun => run !== null);
  if (runs.length === 0) {
    return { blocks: [], text: "", geometryScore: 1 };
  }

  const totalChars = runs.reduce((sum, run) => sum + run.text.trim().length, 0);
  const placedChars = runs.reduce(
    (sum, run) => sum + (run.bbox ? run.text.trim().length : 0),
    0
  );
  const geometryScore = totalChars > 0 ? placedChars / totalChars : 1;

  // Group into lines: same baseline (keyed along the run's up-axis, so
  // rotated text lines up with itself), tolerance scaled to the font.
  const lines: { runs: PlacedRun[]; key: number; fontHeight: number }[] = [];
  for (const run of runs) {
    if (!run.bbox) continue;
    const key = baselineKey(run);
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate.key - key) <=
        Math.max(candidate.fontHeight, run.fontHeight) * 0.35
    );
    if (line) {
      line.runs.push(run);
      line.key = (line.key * (line.runs.length - 1) + key) / line.runs.length;
      line.fontHeight = Math.max(line.fontHeight, run.fontHeight);
    } else {
      lines.push({ runs: [run], key, fontHeight: run.fontHeight });
    }
  }

  const blocks: NativeLineBlock[] = lines.map((line) => {
    const ordered = [...line.runs].sort((a, b) => inlineKey(a) - inlineKey(b));
    const words: (NativeWord & { start: number; end: number })[] = [];
    for (const run of ordered) {
      const fragments = runFragments(run);
      for (const [index, fragment] of fragments.entries()) {
        const previous = words.at(-1);
        const joinable =
          index === 0 &&
          previous &&
          !run.text.startsWith(" ") &&
          fragment.start - previous.end < run.fontHeight * 0.24;
        if (joinable) {
          previous.text += fragment.text;
          previous.end = fragment.end;
          if (previous.bbox && fragment.bbox) {
            previous.bbox = unionBoxes(previous.bbox, fragment.bbox);
          }
        } else {
          words.push({
            text: fragment.text,
            bbox: fragment.bbox ?? undefined,
            start: fragment.start,
            end: fragment.end,
          });
        }
      }
    }
    const bbox = ordered
      .map((run) => run.bbox)
      .filter((box): box is NativeBox => box !== null)
      .reduce<NativeBox | undefined>(
        (union, box) => (union ? unionBoxes(union, box) : box),
        undefined
      );
    return {
      text: words.map((word) => word.text).join(" "),
      bbox: bbox ? roundBox(bbox) : undefined,
      words: words.map((word) => ({
        text: word.text,
        bbox: word.bbox ? roundBox(word.bbox) : undefined,
      })),
    };
  });

  const orderedBlocks = blocks
    .filter((block) => block.text)
    .sort((a, b) =>
      a.bbox && b.bbox ? a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x : 0
    );

  return {
    blocks: orderedBlocks,
    text: orderedBlocks.map((block) => block.text).join("\n"),
    geometryScore,
  };
}

// ---------------------------------------------------------------------------
// Operator-list visibility classification
//
// Rebuilt from the preflight classifier removed in 4a6296d ("Stop warning
// that scanned PDFs come back empty") — the premise it warned about is gone,
// but the classification itself is exactly what decides whether a page's
// embedded text is the page or a scanner's invisible OCR underlay. Text in
// rendering mode 3/7 is invisible; text under a page-sized image displays as
// the image; both must yield to vision OCR rather than be trusted.
// ---------------------------------------------------------------------------

/** An image this much of the page in both dimensions is treated as covering it. */
const FULL_PAGE_IMAGE_RATIO = 0.9;

/** The pdf.js OPS codes the summary reads, passed in so this stays pure. */
export interface PageOpCodes {
  setTextRenderingMode: number;
  showText: number;
  showSpacedText: number;
  nextLineShowText: number;
  nextLineSetSpacingShowText: number;
  paintImageXObject: number;
  paintImageMaskXObject: number;
  transform: number;
  save: number;
  restore: number;
}

export interface PageOpsSummary {
  visibleTextRuns: number;
  hiddenTextRuns: number;
  hasImage: boolean;
  fullPageImage: boolean;
}

export function summarizePageOps(
  ops: { fnArray: number[]; argsArray: unknown[] },
  codes: PageOpCodes,
  pageWidth: number,
  pageHeight: number
): PageOpsSummary {
  const textOps = new Set([
    codes.showText,
    codes.showSpacedText,
    codes.nextLineShowText,
    codes.nextLineSetSpacingShowText,
  ]);
  const imageOps = new Set([
    codes.paintImageXObject,
    codes.paintImageMaskXObject,
  ]);

  let renderMode = 0;
  const summary: PageOpsSummary = {
    visibleTextRuns: 0,
    hiddenTextRuns: 0,
    hasImage: false,
    fullPageImage: false,
  };

  // Track just enough of the graphics state to know how big a painted image
  // is: scale magnitude per axis, saved and restored with the state.
  let ctm: [number, number] = [1, 1];
  const stack: [number, number][] = [];

  for (let index = 0; index < ops.fnArray.length; index += 1) {
    const op = ops.fnArray[index];
    const args = ops.argsArray[index] as number[] | undefined;

    if (op === codes.save) {
      stack.push([...ctm]);
    } else if (op === codes.restore) {
      ctm = stack.pop() ?? [1, 1];
    } else if (op === codes.transform && args && args.length >= 4) {
      ctm = [
        ctm[0] * Math.hypot(args[0] ?? 0, args[1] ?? 0),
        ctm[1] * Math.hypot(args[2] ?? 0, args[3] ?? 0),
      ];
    } else if (op === codes.setTextRenderingMode) {
      renderMode = Number(args?.[0] ?? 0);
    } else if (imageOps.has(op)) {
      summary.hasImage = true;
      if (
        Math.abs(ctm[0]) >= pageWidth * FULL_PAGE_IMAGE_RATIO &&
        Math.abs(ctm[1]) >= pageHeight * FULL_PAGE_IMAGE_RATIO
      ) {
        summary.fullPageImage = true;
      }
    } else if (textOps.has(op)) {
      if (renderMode === 3 || renderMode === 7) summary.hiddenTextRuns += 1;
      else summary.visibleTextRuns += 1;
    }
  }
  return summary;
}

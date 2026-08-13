import type { TextBox } from "../../lib/pdfTextGeometry";

/**
 * Selection geometry lives one box per token, which is right for drawing the
 * live blue selection (it must clip to the exact characters) and wrong for a
 * highlight: five words become five separate slabs with a hairline of white
 * between each, and the marker looks like it skipped the spaces.
 *
 * These helpers turn per-token boxes into the runs a highlighter would
 * actually leave — one rect per contiguous stretch of a line.
 */

/** Two boxes are on the same line when their vertical spans mostly overlap. */
function sameLine(a: TextBox, b: TextBox): boolean {
  const overlap =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap > Math.min(a.height, b.height) * 0.5;
}

/**
 * Merge per-token boxes into contiguous line runs.
 *
 * The gap tolerance scales with line height rather than being a fixed number
 * of units, because these coordinates are page units and a page can be any
 * size: 60% of the line height is about one space at normal typesetting, so
 * word gaps close and a genuine column gutter does not.
 */
export function mergeSelectionRects(boxes: TextBox[]): TextBox[] {
  const usable = boxes.filter((box) => box.width > 0 && box.height > 0);
  if (usable.length === 0) return [];

  const lines: TextBox[][] = [];
  for (const box of usable) {
    // Compare against the line's last box: boxes arrive in reading order, so
    // the most recent one is the nearest neighbour vertically.
    const line = lines.find((candidate) =>
      sameLine(candidate[candidate.length - 1], box)
    );
    if (line) line.push(box);
    else lines.push([box]);
  }

  const merged: TextBox[] = [];
  for (const line of lines) {
    const sorted = [...line].sort((a, b) => a.x - b.x);
    let run = { ...sorted[0] };
    for (const box of sorted.slice(1)) {
      const runRight = run.x + run.width;
      const tolerance = Math.max(run.height, box.height) * 0.6;
      if (box.x <= runRight + tolerance) {
        const right = Math.max(runRight, box.x + box.width);
        const top = Math.min(run.y, box.y);
        const bottom = Math.max(run.y + run.height, box.y + box.height);
        run = { x: run.x, y: top, width: right - run.x, height: bottom - top };
      } else {
        merged.push(run);
        run = { ...box };
      }
    }
    merged.push(run);
  }
  return merged;
}

/** The box every rect fits inside — where a comment card anchors itself. */
export function boundingRect(rects: TextBox[]): TextBox | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

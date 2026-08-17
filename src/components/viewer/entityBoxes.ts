import type { Doc } from "../../../convex/_generated/dataModel";

export type WordBox = { x: number; y: number; width: number; height: number };

const cleanToken = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const isWordChar = (ch: string | undefined) =>
  !!ch && /[\p{L}\p{N}]/u.test(ch);

/**
 * Start indices of `name` inside `text`, case-insensitive, skipping matches
 * that are part of a longer word ("Ann" inside "Announcement").
 */
export function nameOccurrences(text: string, name: string): number[] {
  const hay = text.toLowerCase();
  const needle = name.toLowerCase();
  if (!needle) return [];

  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    const end = idx + needle.length;
    from = end;
    if (isWordChar(hay[idx - 1]) || isWordChar(hay[end])) continue;
    out.push(idx);
  }
  return out;
}

function union(boxes: WordBox[]): WordBox {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}

/** Every consecutive run of OCR words in the block that spells out `name`. */
function wordRunBoxes(
  words: NonNullable<Doc<"blocks">["words"]>,
  name: string
): WordBox[] {
  const nameTokens = name.split(/\s+/).map(cleanToken).filter(Boolean);
  if (nameTokens.length === 0) return [];
  const wordTokens = words.map((w) => cleanToken(w.text));

  const boxes: WordBox[] = [];
  for (let i = 0; i + nameTokens.length <= words.length; i++) {
    let matched = true;
    for (let j = 0; j < nameTokens.length; j++) {
      if (wordTokens[i + j] !== nameTokens[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const run = words
      .slice(i, i + nameTokens.length)
      .map((w) => w.bbox)
      .filter((b): b is WordBox => !!b);
    if (run.length > 0) boxes.push(union(run));
    i += nameTokens.length - 1;
  }
  return boxes;
}

/**
 * Approximate sub-line boxes from character offsets, for blocks that carry no
 * word-level OCR. Blocks are single lines here (see PdfViewer's text
 * layer), so interpolating across the line's width lands close enough for a
 * hover target.
 */
function estimatedBoxes(block: Doc<"blocks">, name: string): WordBox[] {
  const bbox = block.bbox;
  const len = block.text.length;
  if (!bbox || len === 0) return [];

  return nameOccurrences(block.text, name).map((idx) => {
    const x = bbox.x + (bbox.width * idx) / len;
    const width = Math.min(
      Math.max((bbox.width * name.length) / len, 4),
      bbox.x + bbox.width - x
    );
    return { x, y: bbox.y, width, height: bbox.height };
  });
}

/**
 * Tight boxes around every mention of `name` in a block — word-precise when
 * the block carries word-level OCR boxes. With `estimate`, blocks without word
 * data (or whose OCR tokenization doesn't line up with the name) fall back to
 * a character-offset approximation instead of returning nothing.
 */
export function findNameBoxes(
  block: Doc<"blocks">,
  name: string,
  { estimate = false }: { estimate?: boolean } = {}
): WordBox[] {
  if (block.words && block.words.length > 0) {
    const boxes = wordRunBoxes(block.words, name);
    if (boxes.length > 0) return boxes;
  }
  return estimate ? estimatedBoxes(block, name) : [];
}

/** True when `a` and `b` overlap by more than half of the smaller box. */
export function overlaps(a: WordBox, b: WordBox): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return false;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 && (w * h) / smaller > 0.5;
}

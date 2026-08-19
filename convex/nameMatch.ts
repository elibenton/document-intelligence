/**
 * The one definition of "this name occurs here", shared by every surface that
 * matches an entity name against document text: server-side mention grounding
 * (relationships.ts), the sidebar's mention counts (personMentions.ts), and —
 * for its normalization — the Contents search (blockSearch.ts).
 *
 * Before this existed there were four matchers. The strictest (raw per-block
 * `includes`) both missed real occurrences (line breaks, `Nicole.Elliott@…`,
 * HTML entities) and matched inside words ("Eli" in "believe"), which is where
 * sidebar entities that highlight nothing — and mentions that point at nothing
 * — came from.
 *
 * Pure module, no Convex imports, so it can be unit-tested directly (the
 * _generated/server import chain kills vitest — see the repo memory) and
 * imported from src/ the way speakerSignature already is.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Block text carries HTML entities raw (`&lt;Nicole.Elliott@…&gt;` in any
 * mail-derived document); decode before the alphanumeric filter or `&lt;`
 * survives as the letters "lt". */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** A character that survives normalization. Everything else — whitespace,
 * punctuation, quotes of either curliness — is dropped rather than collapsed,
 * so "Sincerely,Nicole", a line break, and a plain space all match the same. */
export const KEEP = /[\p{L}\p{N}]/u;

/** A name reduced to the letters that have to appear, in order. */
export function normalizeName(raw: string): string {
  let out = "";
  for (const char of decodeEntities(raw).normalize("NFKC")) {
    if (KEEP.test(char)) out += char.toLowerCase();
  }
  return out;
}

export interface NameIndex {
  /** Every block's text, normalized and concatenated. */
  normalized: string;
  /** normalized[i] came from position offsets[i] of the virtual document
   * (blocks joined by one space) — a gap between neighbors means a separator
   * stood between them in the original, which is what a word boundary is. */
  offsets: number[];
  /** Index into the block list for each normalized character. */
  blockAt: number[];
  /** Where each block begins in the virtual document. */
  blockStart: number[];
}

/** Build once per block set, match many names against it. */
export function buildNameIndex(texts: string[]): NameIndex {
  let base = 0;
  let normalized = "";
  const offsets: number[] = [];
  const blockAt: number[] = [];
  const blockStart: number[] = [];

  for (let b = 0; b < texts.length; b++) {
    const text = decodeEntities(texts[b]).normalize("NFKC");
    blockStart.push(base);
    for (let i = 0; i < text.length; i++) {
      if (!KEEP.test(text[i])) continue;
      normalized += text[i].toLowerCase();
      offsets.push(base + i);
      blockAt.push(b);
    }
    base += text.length + 1; // the virtual space between blocks
  }

  return { normalized, offsets, blockAt, blockStart };
}

export interface NameOccurrence {
  /** The variant (name or alias) that matched. */
  variant: string;
  /** The block the occurrence starts in. */
  blockIndex: number;
  /** Character range of the match within that block's decoded (NFKC) text.
   * The end may spill past the block when the name crosses a block boundary —
   * callers slicing snippets should clamp. */
  start: number;
  end: number;
}

/**
 * Every word-bounded occurrence of any variant, in index order.
 *
 * Word-bounded: the characters just outside the match must not have been
 * adjacent alphanumerics in the original text — read straight off the offset
 * gaps, so "Eli" matches "Hey there, Eli." and never the inside of "believe".
 * Variants are deduped by normalized form (first spelling wins, so pass the
 * display name first); one-character variants match too much to be useful and
 * are skipped.
 */
export function findNameOccurrences(
  index: NameIndex,
  variants: string[]
): NameOccurrence[] {
  const { normalized, offsets, blockAt, blockStart } = index;
  const seen = new Set<string>();
  const out: NameOccurrence[] = [];

  for (const variant of variants) {
    const q = normalizeName(variant);
    if (q.length < 2 || seen.has(q)) continue;
    seen.add(q);

    let from = 0;
    for (;;) {
      const at = normalized.indexOf(q, from);
      if (at === -1) break;
      from = at + 1;

      const last = at + q.length - 1;
      const boundedLeft = at === 0 || offsets[at] - offsets[at - 1] > 1;
      const boundedRight =
        last === offsets.length - 1 || offsets[last + 1] - offsets[last] > 1;
      if (!boundedLeft || !boundedRight) continue;

      const blockIndex = blockAt[at];
      out.push({
        variant,
        blockIndex,
        start: offsets[at] - blockStart[blockIndex],
        end: offsets[last] + 1 - blockStart[blockIndex],
      });
    }
  }

  return out.sort((a, b) => a.blockIndex - b.blockIndex || a.start - b.start);
}

/** The block indexes any variant occurs in — what mention grounding stores. */
export function matchedBlockIndexes(
  index: NameIndex,
  variants: string[]
): Set<number> {
  const blocks = new Set<number>();
  for (const occurrence of findNameOccurrences(index, variants)) {
    blocks.add(occurrence.blockIndex);
  }
  return blocks;
}

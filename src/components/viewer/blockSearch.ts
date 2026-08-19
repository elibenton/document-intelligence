import type { TocBlock } from "./TableOfContents";

export interface SearchHit {
  /** Unique per occurrence — a block can match more than once. */
  key: string;
  blockId: string;
  /** 0-based, like every block page number. */
  pageNumber: number;
  snippet: string;
  /** The document's own text for this match, verbatim — the snippet
   * highlights this rather than the query, because the two differ wherever
   * the stored text spells the whitespace differently than the reader did. */
  matchText: string;
  /** Character offset of the match inside its own block's text — how a
   * transcript hit finds the exact word (and so the exact second) to seek. */
  blockOffset: number;
}

export interface SearchOutcome {
  hits: SearchHit[];
  totalMatches: number;
}

const EMPTY: SearchOutcome = { hits: [], totalMatches: 0 };

/** A query shorter than this matches too much of the document to be useful.
 * Counted in normalized characters, so punctuation and spaces don't pad it. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Characters of context kept around the match in a snippet — deliberately
 * asymmetric. The list renders snippets under a line clamp that eats from
 * the end, so a long lead-in pushes the match itself off the visible text at
 * narrow panel widths. A short lead anchors the match near the snippet's
 * start; the tail carries the readable context and is what the clamp
 * sacrifices first.
 */
const SNIPPET_BEFORE = 25;
const SNIPPET_AFTER = 90;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Entities have to go before the alphanumeric filter, or `&lt;` survives it as
 * the letters "lt" and corrupts everything around it. Block text carries them
 * raw — see the `&lt;Nicole.Elliott@…&gt;` blocks in any mail-derived document.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * True when a character survives normalization. Everything else — whitespace,
 * punctuation, quotes of either curliness — is dropped rather than collapsed.
 *
 * Dropping whitespace instead of normalizing it is the whole point. Extracted
 * block text spells a line join three different ways: a newline, a run of
 * spaces, or nothing at all ("Sincerely,Nicole"), and a reader typing the
 * phrase has no way to know which one they got. Ignoring the question entirely
 * is the only rule that matches all three.
 */
const KEEP = /[\p{L}\p{N}]/u;

export interface SearchIndex {
  /** Every block's text, lowercased down to alphanumerics, concatenated. */
  normalized: string;
  /** normalized[i] came from joined[offsets[i]]. */
  offsets: number[];
  /** Index into `blocks` for each normalized character. */
  blockAt: number[];
  /** Original block text, one space per block boundary — the snippet source. */
  joined: string;
  /** Where each block's text begins in `joined`. */
  blockJoinedStart: number[];
  blocks: TocBlock[];
}

/**
 * Build the document's search index once per block set, not once per keystroke.
 *
 * The index spans the whole document rather than stopping at each block because
 * blocks are not paragraphs — measured against live data they run to a median
 * of 25 characters, and in some documents to a single word each. Matching
 * inside one block at a time made every phrase that crosses a line break
 * unfindable, which was 60% of six-word phrases in the worst corpus sampled.
 */
export function buildSearchIndex(blocks: TocBlock[]): SearchIndex {
  let joined = "";
  let normalized = "";
  const offsets: number[] = [];
  const blockAt: number[] = [];
  const blockJoinedStart: number[] = [];

  for (let b = 0; b < blocks.length; b++) {
    // NFKC first, so ligatures and exotic spaces reduce to their plain forms.
    const text = decodeEntities(blocks[b].text).normalize("NFKC");
    const base = joined.length;
    blockJoinedStart.push(base);
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (!KEEP.test(char)) continue;
      normalized += char.toLowerCase();
      offsets.push(base + i);
      blockAt.push(b);
    }
    // A space between blocks keeps snippets readable; it is invisible to
    // `normalized`, so it cannot break a match that spans the boundary.
    joined += text + " ";
  }

  return { normalized, offsets, blockAt, joined, blockJoinedStart, blocks };
}

export function normalizeQuery(query: string): string {
  let out = "";
  const text = decodeEntities(query).normalize("NFKC");
  for (const char of text) if (KEEP.test(char)) out += char.toLowerCase();
  return out;
}

/**
 * Every occurrence of the query, in document order. One hit per occurrence
 * rather than per block: with line-level blocks, "per block" and "per match"
 * had drifted into meaning the same thing anyway, and the count in the results
 * header now means what it says.
 */
export function searchIndex(index: SearchIndex, query: string): SearchOutcome {
  const q = normalizeQuery(query);
  if (q.length < MIN_QUERY_LENGTH) return EMPTY;

  const hits: SearchHit[] = [];
  const { normalized, offsets, blockAt, joined, blocks } = index;

  let from = 0;
  for (;;) {
    const at = normalized.indexOf(q, from);
    if (at === -1) break;
    from = at + q.length;

    const matchStart = offsets[at];
    const matchEnd = offsets[at + q.length - 1] + 1;
    let start = Math.max(0, matchStart - SNIPPET_BEFORE);
    const end = Math.min(joined.length, matchEnd + SNIPPET_AFTER);

    // Snap a mid-word cut forward to the next word boundary, so the lead-in
    // reads "…youth treatment" rather than "…outh treatment".
    if (start > 0) {
      const space = joined.indexOf(" ", start);
      if (space !== -1 && space < matchStart) start = space + 1;
    }

    let snippet = joined.slice(start, end);
    if (start > 0) snippet = "…" + snippet;
    if (end < joined.length) snippet += "…";

    const block = blocks[blockAt[at]];
    hits.push({
      key: `${block._id}:${matchStart}`,
      blockId: block._id,
      pageNumber: block.pageNumber,
      snippet,
      matchText: joined.slice(matchStart, matchEnd),
      blockOffset: matchStart - index.blockJoinedStart[blockAt[at]],
    });
  }

  // Blocks arrive in reading order, so hits are already page-ordered; sorting
  // is only insurance against a document whose blocks are not.
  hits.sort((a, b) => a.pageNumber - b.pageNumber);
  return { hits, totalMatches: hits.length };
}

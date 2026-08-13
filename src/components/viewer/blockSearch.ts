import type { TocBlock } from "./TableOfContents";

export interface SearchHit {
  blockId: string;
  /** 0-based, like every block page number. */
  pageNumber: number;
  snippet: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Blocks matched, not pages — one page can contain several. */
  totalMatches: number;
}

const EMPTY: SearchOutcome = { hits: [], totalMatches: 0 };

/** A query shorter than this matches too much of the document to be useful. */
export const MIN_QUERY_LENGTH = 2;

/** Characters of context kept on each side of the match in a snippet. */
const SNIPPET_CONTEXT = 160;

/**
 * Full-text scan over the document's blocks. One hit per matching block —
 * every instance gets its own snippet, since callers group them by section
 * (see ContentsPanel/DocumentSearch) rather than needing this to collapse
 * repeats itself.
 */
export function searchBlocks(blocks: TocBlock[], query: string): SearchOutcome {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY_LENGTH) return EMPTY;

  const hits: SearchHit[] = [];

  for (const block of blocks) {
    const textLower = block.text.toLowerCase();
    const idx = textLower.indexOf(q);
    if (idx === -1) continue;

    const start = Math.max(0, idx - SNIPPET_CONTEXT);
    const end = Math.min(block.text.length, idx + q.length + SNIPPET_CONTEXT);
    let snippet = block.text.slice(start, end);
    if (start > 0) snippet = "…" + snippet;
    if (end < block.text.length) snippet += "…";

    hits.push({ blockId: block._id, pageNumber: block.pageNumber, snippet });
  }

  hits.sort((a, b) => a.pageNumber - b.pageNumber);
  return { hits, totalMatches: hits.length };
}

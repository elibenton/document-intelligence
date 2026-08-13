import type { OutlineEntry, TocBlock } from "./TableOfContents";

export interface TocHeader {
  id: string;
  text: string;
  /** 0-based, like every block page number. */
  pageNumber: number;
  level: number;
}

/**
 * The document's section list, from whichever source is available. Analyze's
 * outline wins when it exists — it read the whole document and knows a
 * subsection from a chapter. SectionHeader blocks stay as the fallback for
 * documents scanned before Analyze ran, or that have no structure worth
 * outlining. `pageNumber` is 0-based throughout, matching blocks; the outline
 * stores 1-based pages, so that conversion happens once here.
 *
 * Shared with the search results view (DocumentSearch, via ContentsPanel) so
 * a match and the outline agree on what to call the section it's in.
 */
export function buildTocHeaders(
  blocks: TocBlock[],
  outline?: OutlineEntry[]
): TocHeader[] {
  if (outline && outline.length > 0) {
    return outline.map((entry, index) => ({
      id: `toc-${index}`,
      text: entry.title,
      pageNumber: entry.page - 1,
      level: entry.level,
    }));
  }
  return blocks
    .filter((b) => b.blockType === "SectionHeader" && b.text.trim())
    .map((b) => ({
      id: b._id as string,
      text: b.text.trim(),
      pageNumber: b.pageNumber,
      level: 1,
    }));
}

/**
 * Which section a page falls under — the last header at or before it.
 * Assumes `headers` is in document order, which both of buildTocHeaders'
 * sources already are (Analyze's outline; SectionHeader blocks in scan order).
 */
export function sectionForPage(
  headers: TocHeader[],
  pageNumber: number
): TocHeader | null {
  let match: TocHeader | null = null;
  for (const header of headers) {
    if (header.pageNumber > pageNumber) break;
    match = header;
  }
  return match;
}

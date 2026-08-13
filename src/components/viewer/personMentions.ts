export interface PersonMention {
  blockId: string;
  pageNumber: number; // 0-indexed
  text: string; // the block text containing the person's name
  snippet: string; // short context around the name
}

/**
 * Find all mentions of a person across all blocks, returning page numbers and
 * snippets. Accepts the lightweight block shape (no word boxes needed).
 *
 * Lives outside PersonHighlight.tsx so that file exports only components —
 * mixing the two breaks React Fast Refresh for the module.
 */
export function findPersonMentions(
  blocks: { _id: string; text: string; pageNumber: number }[],
  personName: string
): PersonMention[] {
  const nameLower = personName.toLowerCase();
  const mentions: PersonMention[] = [];
  const seenPages = new Set<number>();

  for (const block of blocks) {
    if (!block.text.toLowerCase().includes(nameLower)) continue;

    // Build a snippet around the first occurrence
    const idx = block.text.toLowerCase().indexOf(nameLower);
    const start = Math.max(0, idx - 40);
    const end = Math.min(block.text.length, idx + personName.length + 40);
    let snippet = block.text.slice(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < block.text.length) snippet = snippet + "...";

    // Only add one mention per page to keep the list concise
    if (!seenPages.has(block.pageNumber)) {
      seenPages.add(block.pageNumber);
      mentions.push({
        blockId: block._id,
        pageNumber: block.pageNumber,
        text: block.text,
        snippet,
      });
    }
  }

  return mentions.sort((a, b) => a.pageNumber - b.pageNumber);
}

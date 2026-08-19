import {
  buildNameIndex,
  decodeEntities,
  findNameOccurrences,
} from "../../../convex/nameMatch";

export interface PersonMention {
  blockId: string;
  pageNumber: number; // 0-indexed
  text: string; // the block text containing the name
  snippet: string; // short context around the name
  /** The spelling that actually appears here — the display name or an alias.
   * This is what a click loads into search, so the search finds it too. */
  variant: string;
}

/**
 * Find mentions of an entity across all blocks — the shared normalized,
 * word-bounded matcher (convex/nameMatch.ts), tried against every spelling
 * the entity has carried. Accepts the lightweight block shape.
 *
 * Lives outside PersonHighlight.tsx so that file exports only components —
 * mixing the two breaks React Fast Refresh for the module.
 */
export function findPersonMentions(
  blocks: { _id: string; text: string; pageNumber: number }[],
  variants: string[]
): PersonMention[] {
  const index = buildNameIndex(blocks.map((b) => b.text));
  const occurrences = findNameOccurrences(index, variants);

  // Only one mention per page, to keep the list concise.
  const seenPages = new Set<number>();
  const mentions: PersonMention[] = [];
  for (const hit of occurrences) {
    const block = blocks[hit.blockIndex];
    if (seenPages.has(block.pageNumber)) continue;
    seenPages.add(block.pageNumber);

    // Offsets are against the decoded (NFKC) text; slice the same string.
    const text = decodeEntities(block.text).normalize("NFKC");
    const start = Math.max(0, hit.start - 40);
    const end = Math.min(text.length, hit.end + 40);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";

    mentions.push({
      blockId: block._id,
      pageNumber: block.pageNumber,
      text: block.text,
      snippet,
      variant: hit.variant,
    });
  }

  return mentions.sort((a, b) => a.pageNumber - b.pageNumber);
}

/** The spelling to load into search for this entity: the one that occurs
 * most, display name winning ties. Null when nothing matches the text. */
export function bestSearchVariant(mentions: PersonMention[]): string | null {
  if (mentions.length === 0) return null;
  const counts = new Map<string, number>();
  for (const m of mentions) {
    counts.set(m.variant, (counts.get(m.variant) ?? 0) + 1);
  }
  let best = mentions[0].variant;
  for (const [variant, count] of counts) {
    if (count > (counts.get(best) ?? 0)) best = variant;
  }
  return best;
}

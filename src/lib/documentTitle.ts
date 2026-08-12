/**
 * A document is shown under two names: the AI-written title from the rename
 * pass (convex/rename.ts) on top, and the name the file arrived with beneath
 * it, so the reader can still recognize their own upload. Before the rename
 * pass has run there is only one name, and the second line is omitted.
 */
export function documentTitles(doc: { name: string; displayName?: string }): {
  primary: string;
  original: string | null;
} {
  const renamed = doc.displayName?.trim();
  return renamed && renamed !== doc.name
    ? { primary: renamed, original: doc.name }
    : { primary: doc.name, original: null };
}

/**
 * The slug in `/entity/:slug`.
 *
 * Lives here because three call sites had grown their own copy — the entity
 * page, the document sidebar, and the connections panel — and a slug that
 * disagrees between the link and the lookup is a dead route, not a cosmetic
 * difference. `convex/entities.ts` getBySlug matches against this shape.
 */
export function entitySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

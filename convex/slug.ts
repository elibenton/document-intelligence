/**
 * The slug shape used by `/p/:slug` and `/entity/:slug`.
 *
 * It lives on the Convex side because the server is what stores and indexes
 * these: a slug the client mints differently from the one the server wrote is a
 * dead route, not a cosmetic difference. `src/lib/entitySlug.ts` re-exports it
 * rather than keeping a second copy, which is how the last five copies drifted
 * into being.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

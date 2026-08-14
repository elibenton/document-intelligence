/**
 * The slug in `/entity/:slug`, re-exported from the Convex module that owns it.
 *
 * The definition lives in `convex/slug.ts` because the server stores and indexes
 * these values; a client copy that drifts from it produces a dead route. This
 * file stays only so the existing `@/lib/entitySlug` imports keep resolving.
 */
export { slugify as entitySlug } from "../../convex/slug";

/**
 * The demo's limits, in a module with no Convex imports so the browser can
 * read them too.
 *
 * Same bargain as convex/interfazeLimits.ts: the number a visitor is told and
 * the number the server enforces have to be the same number, and the only way
 * to guarantee that is for there to be one. `src/components/landing/` imports
 * these to refuse a file before it is uploaded; convex/demo.ts imports them to
 * refuse it again for a caller who skipped the browser.
 *
 * A constant here is a *courtesy* on the client and the *enforcement* on the
 * server — never the other way around. See the header of convex/demo.ts.
 */

/** Pages a demo document may have. */
export const DEMO_MAX_PAGES = 10;

/**
 * Byte ceiling. A 10-page born-digital PDF measures well under a megabyte;
 * this leaves room for one that is mostly scanned images while staying far
 * below the provider's 20 MB file-object transport.
 */
export const DEMO_MAX_BYTES = 8_000_000;

/** Refusals the landing page renders a specific state for. */
export const DEMO_UNAVAILABLE = "demo_unavailable";
export const DEMO_ALREADY_USED = "demo_already_used";
export const DEMO_TOO_LARGE = "demo_too_large";
export const DEMO_TOO_MANY_PAGES = "demo_too_many_pages";
export const DEMO_WRONG_TYPE = "demo_wrong_type";

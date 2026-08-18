/**
 * Interfaze input-size ceiling — one number, one transport.
 *
 * Every call sends the document as a `file` content part carrying the storage
 * URL (never URL-in-prompt-text: measured 2026-08-18, the full model silently
 * analyzed the *wrong document* for a URL pasted into prompt text — three
 * different wrong documents across cached, uncached, and repeat calls — while
 * the file part read the right one every time).
 *
 * The ceiling is measured, not documented. The docs claim 20 MB for file
 * objects, but a 34 MB file part transcribed correctly and a 62 MB one died
 * after ~160s with an opaque 500 `model_error` (req-ef186731, reported to
 * Interfaze). 34 MB is the largest size that has actually worked, so it is the
 * gate — to be raised when Interfaze answers with the real enforced limit.
 *
 * Kept free of the SDK and of "use node" on purpose: the browser preflights
 * import this too, so the ceiling a user is shown at upload and the ceiling
 * the pipeline enforces cannot drift apart.
 */

export const PROVIDER_FILE_PART_SAFE_BYTES = 34_000_000;

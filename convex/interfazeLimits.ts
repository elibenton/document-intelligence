/**
 * Interfaze input-size ceilings — https://interfaze.ai/docs/limits.
 *
 * Two numbers, one per transport: a URL in prompt text is capped at 80 MB, a
 * file object at 20 MB. The docs give the reason for the smaller one — "most AI
 * SDKs convert urls in file objects to base64 automatically" — which is not
 * what happens here: the `interfaze` SDK's `inputs.file` passes the URL through
 * verbatim and never inlines bytes. The ceiling is nonetheless enforced by
 * transport rather than by payload, and this has not been measured past 20 MB,
 * so both numbers are treated as real and the transport is chosen by size
 * (see `fileUrlContent` in convex/interfaze.ts).
 *
 * Kept free of the SDK and of "use node" on purpose: the browser preflights
 * import these too, so the ceiling a user is shown at upload and the ceiling
 * the pipeline enforces cannot drift apart.
 */

/**
 * The documented 80 MB URL ceiling, less deliberate headroom for redirects and
 * provider-side size accounting. This is the largest file the app will accept.
 */
export const PROVIDER_URL_SAFE_BYTES = 70_000_000;

/**
 * The documented 20 MB file-object ceiling, less headroom. Above this a caller
 * must send the URL as prompt text instead, which costs more but is the only
 * transport that reaches 80 MB.
 */
export const PROVIDER_FILE_OBJECT_SAFE_BYTES = 19_000_000;

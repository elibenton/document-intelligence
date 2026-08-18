/**
 * FNV-1a, 8 hex chars. Not a security hash — it is a cheap grouping key, and a
 * collision costs a mis-grouped row and nothing more.
 *
 * A leaf module with no imports, for the same reason interfazeCost.ts and
 * interfazeErrors.ts are: convex/interfaze.ts is `"use node"`, so anything that
 * lives there cannot be reached from an ordinary mutation. Two callers now
 * share this — the API log's prompt/output hashes and the issue ledger's
 * fingerprint — and a second copy would drift the moment either one is tuned.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A demo owner id is `demo:<64-hex session token>`, and that token is the
 * session's whole credential (convex/demo.ts). It is correct as the ownership
 * key on live rows, but it must not be copied verbatim into the log/sample
 * columns an operator or triage agent reads — `apiLogs.ownerId` and
 * `issues.ownerSample` — where it would sit for the row's lifetime as a working
 * bearer token. Replace the token with its FNV hash: still one stable value per
 * session, so distinct-account counts are unchanged, but no longer a usable
 * credential and not invertible back to one. Real Better Auth ids carry no
 * colon and pass through untouched, so the admin name/email join still works.
 */
export function redactOwnerForLog(
  ownerId: string | undefined
): string | undefined {
  if (!ownerId?.startsWith("demo:")) return ownerId;
  return `demo:${fnv1a(ownerId.slice("demo:".length))}`;
}

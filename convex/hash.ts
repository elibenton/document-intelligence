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

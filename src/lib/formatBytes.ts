/**
 * One byte formatter for the whole upload surface.
 *
 * There were three, and two of them divided by 1024 while the preflight divided
 * by 1000 — so a single upload card could report two different sizes for one
 * file, and neither matched the megabytes in the provider's own limits. Decimal
 * wins because that is what those limits are quoted in.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
}

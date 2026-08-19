/** "1h 5m" past the hour, "5:03" under it — shared by the upload preflight
 *  detail line, the library's Duration column, and the viewer bar. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return null;
  }
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  return hours > 0
    ? `${hours}h ${minutes}m`
    : `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

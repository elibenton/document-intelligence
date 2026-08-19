/**
 * Sanitizers for dates a FILE or SOURCE states about itself — a clip's
 * article:published_time, a PDF's Info CreationDate, an EXIF DateTimeOriginal,
 * a recording container's creation time.
 *
 * Pure string work, no Convex imports, so the browser ingest path and the
 * backfill action run the identical code and the tests can pin it without a
 * runtime. Same bargain as sanitizeDocumentDate in metadata.ts: a value that
 * cannot be trusted degrades to nothing rather than misfiling the document.
 */

export interface NativeDate {
  value: string;
  precision: "day" | "month" | "year";
}

/**
 * A source-stated date as an ISO prefix with its inherent precision, or
 * nothing.
 *
 * Accepts "YYYY", "YYYY-MM", "YYYY-MM-DD", and full ISO timestamps (which
 * carry day precision — the time of day is more than the library displays).
 * Impossible dates are caught by the same UTC round-trip check the model's
 * sanitizer uses. A future date is dropped with a +48h allowance: camera and
 * recorder clocks drift, but a date further out than that is a scheduled post
 * or a broken clock — wrong either way.
 */
export function sanitizeNativeDate(raw: unknown, now: number): NativeDate | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  // The date prefix, optionally followed by a time part we ignore.
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ]\d{2}[:.].*)?$/.exec(
    text
  );
  if (!match) return null;
  const [, year, month, day] = match;

  const precision: NativeDate["precision"] = day
    ? "day"
    : month
      ? "month"
      : "year";
  const value = day ? `${year}-${month}-${day}` : month ? `${year}-${month}` : year;

  // Parsed as UTC so a timezone can't shift a bare date across a day
  // boundary; Date.parse normalizes impossible dates, so compare it back.
  const whole =
    precision === "year"
      ? `${value}-01-01`
      : precision === "month"
        ? `${value}-01`
        : value;
  const parsed = new Date(`${whole}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (precision === "day" && parsed.toISOString().slice(0, 10) !== value) {
    return null;
  }
  if (precision === "month" && parsed.toISOString().slice(0, 7) !== value) {
    return null;
  }
  if (parsed.getTime() > now + CLOCK_SKEW_MS) return null;

  return { value, precision };
}

/** Two days of clock skew — a recorder set fast is not a hallucination. */
export const CLOCK_SKEW_MS = 48 * 60 * 60 * 1000;

/**
 * An EXIF datetime ("2019:03:14 10:22:01") as an ISO string, or nothing.
 * Cameras write all-blank fields ("    :  :  ") when the clock was never set.
 */
export function exifStringToIso(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})(?:\s+\d{2}:\d{2}:\d{2})?/.exec(
    raw.trim()
  );
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * A PDF date ("D:20190314102201+02'00'", spec-legal truncations included) as
 * an ISO prefix carrying exactly the precision the file stated, or nothing.
 */
export function pdfDateToIso(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  if (!month) return year;
  if (!day) return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

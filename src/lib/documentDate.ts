/**
 * Rendering the date a document says it was made.
 *
 * This is deliberately not the upload date. The library used to show when a
 * file reached us, which is a fact about the filing cabinet rather than about
 * the document — two letters written a decade apart look identical if they
 * were dropped in on the same afternoon.
 *
 * Analyze only fills this in when the document states its own date, and
 * `sanitizeDocumentDate` (convex/metadata.ts) drops anything malformed, so the
 * absent case is common and is shown plainly rather than papered over.
 */

/** Formatted in UTC, so a bare "2026-08-08" can't slide a day in a west-of-UTC timezone. */
const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const MONTH = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const UNKNOWN_DATE_LABEL = "Unknown date";

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Words Analyze uses for "no date", which must not parse as one. */
const NOT_A_DATE = /^(unknown|unspecified|none|n\/?a|n\.?d\.?|undated)$/i;

interface DatedTo {
  value: string;
  precision: "day" | "month" | "year";
}

/**
 * Read a date out of the free-text `date` Analyze has always written into
 * `metadata`, for documents analyzed before `documentDate` existed.
 *
 * That field is prose — "March 14, 2019", "2019-03-14", "1998", "Unknown" —
 * so this accepts the handful of shapes it actually produces and refuses
 * everything else. Anything ambiguous is left undated: the whole point of the
 * new field is that a wrong date is worse than no date, and a lenient fallback
 * would reintroduce exactly what it was added to prevent. Notably absent is
 * numeric "03/04/2019", which is March 4th or April 3rd depending on where the
 * document was written and cannot be told apart here.
 */
function parseLooseDate(raw: string): DatedTo | null {
  const text = raw.trim();
  if (!text || NOT_A_DATE.test(text)) return null;

  // ISO, full or truncated — what Analyze emits when the document is explicit.
  const iso = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(text);
  if (iso) {
    const [, year, month, day] = iso;
    if (day) return { value: `${year}-${month}-${day}`, precision: "day" };
    if (month) return { value: `${year}-${month}`, precision: "month" };
    return { value: year, precision: "year" };
  }

  // "March 14, 2019" / "14 March 2019" / "March 2019"
  const named = /^(?:(\d{1,2})\s+)?([a-z]+)\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/i.exec(
    text
  );
  if (named) {
    const [, dayBefore, monthWord, dayAfter, year] = named;
    const monthIndex = MONTH_NAMES.findIndex(
      (name) => name === monthWord.toLowerCase() || name.slice(0, 3) === monthWord.toLowerCase()
    );
    if (monthIndex >= 0) {
      const month = String(monthIndex + 1).padStart(2, "0");
      const day = dayBefore ?? dayAfter;
      if (day) {
        const dayNumber = Number(day);
        if (dayNumber >= 1 && dayNumber <= 31) {
          return {
            value: `${year}-${month}-${String(dayNumber).padStart(2, "0")}`,
            precision: "day",
          };
        }
      }
      return { value: `${year}-${month}`, precision: "month" };
    }
  }

  // A bare year inside a longer phrase ("circa 1998", "FY 2019") is a year.
  const bareYear = /^(?:c\.?|ca\.?|circa|fy|copyright|©)\s*(\d{4})$/i.exec(text);
  if (bareYear) return { value: bareYear[1], precision: "year" };

  return null;
}

/**
 * The date a document says it was made, from whichever field has it.
 *
 * `documentDate` is the structured answer from the current Analyze prompt.
 * Documents analyzed before it existed only have the prose `date` inside
 * `metadata`, and re-analyzing the whole corpus to fill in a field we can
 * already read is not worth an API bill — so that is the fallback.
 */
export function documentDateOf(doc: {
  documentDate?: string;
  documentDatePrecision?: string;
  metadata?: string;
}): DatedTo | null {
  if (doc.documentDate) {
    const precision = doc.documentDatePrecision;
    if (precision === "day" || precision === "month" || precision === "year") {
      return { value: doc.documentDate, precision };
    }
    return parseLooseDate(doc.documentDate);
  }

  if (!doc.metadata) return null;
  try {
    const parsed = JSON.parse(doc.metadata) as { date?: unknown };
    return typeof parsed.date === "string" ? parseLooseDate(parsed.date) : null;
  } catch {
    return null;
  }
}

/**
 * "Aug 8, 2026", "Aug 2026", "2026", or "Unknown date".
 *
 * The precision is honored rather than padded: a document that only dates
 * itself to a month is shown as that month. Rendering it as the 1st would be
 * inventing a day the document never claimed.
 */
export function formatDocumentDate(doc: {
  documentDate?: string;
  documentDatePrecision?: string;
  metadata?: string;
}): string {
  const dated = documentDateOf(doc);
  if (!dated) return UNKNOWN_DATE_LABEL;
  if (dated.precision === "year") return dated.value;

  const parsed = new Date(
    dated.precision === "month" ? `${dated.value}-01T00:00:00Z` : `${dated.value}T00:00:00Z`
  );
  if (Number.isNaN(parsed.getTime())) return UNKNOWN_DATE_LABEL;

  return dated.precision === "month" ? MONTH.format(parsed) : DAY.format(parsed);
}

/**
 * A key that sorts documents chronologically by the date they were made.
 *
 * ISO prefixes compare correctly as plain strings, and a coarser date sorts
 * before any finer date inside it ("2013-01" < "2013-01-14") — which is the
 * right answer: a document known only to January is not known to fall after
 * the 14th. Null for undated documents, which callers place last in both
 * directions rather than clustering them at whichever end sorts first.
 */
export function documentDateSortKey(doc: {
  documentDate?: string;
  documentDatePrecision?: string;
  metadata?: string;
}): string | null {
  return documentDateOf(doc)?.value ?? null;
}

/**
 * Compare two documents by their own date, newest or oldest first, with
 * undated documents pinned to the bottom either way — an unknown date is not
 * "very old", and letting it sort as one would bury real documents under it.
 */
export function compareByDocumentDate(
  a: Parameters<typeof documentDateSortKey>[0],
  b: Parameters<typeof documentDateSortKey>[0],
  direction: "newest" | "oldest"
): number {
  const aKey = documentDateSortKey(a);
  const bKey = documentDateSortKey(b);
  if (aKey === null && bKey === null) return 0;
  if (aKey === null) return 1;
  if (bKey === null) return -1;
  return direction === "oldest" ? aKey.localeCompare(bKey) : bKey.localeCompare(aKey);
}

/** True when the document could be dated, for styling the label as absent. */
export function hasDocumentDate(doc: {
  documentDate?: string;
  documentDatePrecision?: string;
  metadata?: string;
}): boolean {
  return documentDateOf(doc) !== null;
}

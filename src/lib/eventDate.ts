/**
 * Formatting for `relationships.eventDate`.
 *
 * Extraction asks for "ISO format preferred", which in practice yields a mix of
 * 2024-03-03, 2024-03 and 2024 — and occasionally a phrase the model refused to
 * normalize. Each width formats to exactly what it knows: rendering "March 3,
 * 2024" for a value that only ever said "2024" would assert a precision the
 * document never supported.
 *
 * Separate from the entity components so they export only components, which is
 * what keeps React Fast Refresh working for that module.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Returns null when there is nothing worth showing — no date, or a free-text
 * value too long to sit in a timeline rail. Callers use null to mean
 * "undated", so this doubles as the timeline's inclusion test.
 */
export function formatEventDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const match = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(value);
  if (!match) {
    // Not ISO-ish. Keep a short phrase ("summer 2019"); drop anything long
    // enough to be a sentence the model put in the wrong field.
    return value.length <= 24 ? value : null;
  }

  const [, year, month, day] = match;
  const monthName = month ? MONTHS[Number(month) - 1] : undefined;
  // A month outside 1-12 is corrupt; fall back to the part we can trust.
  if (month && !monthName) return year;
  if (day && monthName) return `${monthName} ${Number(day)}, ${year}`;
  if (monthName) return `${monthName} ${year}`;
  return year;
}

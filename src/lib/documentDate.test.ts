import { describe, expect, it } from "vitest";
import { formatDocumentDate, hasDocumentDate } from "./documentDate";

const meta = (date: unknown) => JSON.stringify({ date });

describe("formatDocumentDate", () => {
  it("formats the structured field at each precision", () => {
    expect(
      formatDocumentDate({ documentDate: "2026-08-08", documentDatePrecision: "day" })
    ).toBe("Aug 8, 2026");
    expect(
      formatDocumentDate({ documentDate: "2026-08", documentDatePrecision: "month" })
    ).toBe("Aug 2026");
    expect(
      formatDocumentDate({ documentDate: "2019", documentDatePrecision: "year" })
    ).toBe("2019");
  });

  it("does not pad a month up to a day", () => {
    // "Aug 1, 2026" would be claiming a day the document never gave.
    expect(
      formatDocumentDate({ documentDate: "2026-08", documentDatePrecision: "month" })
    ).not.toContain("1");
  });

  it("says so when there is no date", () => {
    expect(formatDocumentDate({})).toBe("Unknown date");
    expect(hasDocumentDate({})).toBe(false);
  });

  it("falls back to the prose date in older analyze metadata", () => {
    expect(formatDocumentDate({ metadata: meta("2019-03-14") })).toBe("Mar 14, 2019");
    expect(formatDocumentDate({ metadata: meta("March 14, 2019") })).toBe("Mar 14, 2019");
    expect(formatDocumentDate({ metadata: meta("14 March 2019") })).toBe("Mar 14, 2019");
    expect(formatDocumentDate({ metadata: meta("March 2019") })).toBe("Mar 2019");
    expect(formatDocumentDate({ metadata: meta("1998") })).toBe("1998");
    expect(formatDocumentDate({ metadata: meta("circa 1998") })).toBe("1998");
  });

  it("treats the prose field's no-date words as unknown", () => {
    for (const value of ["Unknown", "unknown", "n/a", "N.D.", "undated", ""]) {
      expect(formatDocumentDate({ metadata: meta(value) })).toBe("Unknown date");
    }
  });

  it("refuses an ambiguous numeric date rather than picking a reading", () => {
    // 03/04/2019 is March 4th or April 3rd depending on where it was written.
    expect(formatDocumentDate({ metadata: meta("03/04/2019") })).toBe("Unknown date");
  });

  it("survives metadata that isn't JSON", () => {
    expect(formatDocumentDate({ metadata: "not json at all" })).toBe("Unknown date");
    expect(formatDocumentDate({ metadata: JSON.stringify({ date: 42 }) })).toBe(
      "Unknown date"
    );
  });

  it("prefers the structured field over the prose one", () => {
    expect(
      formatDocumentDate({
        documentDate: "2026-08-08",
        documentDatePrecision: "day",
        metadata: meta("March 14, 2019"),
      })
    ).toBe("Aug 8, 2026");
  });
});

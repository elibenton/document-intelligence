import { describe, expect, it } from "vitest";
import {
  sanitizeDocumentDate,
  sanitizeDocumentPlace,
  sanitizeTableOfContents,
} from "./metadata";

describe("sanitizeTableOfContents", () => {
  it("keeps a well-formed outline as-is", () => {
    expect(
      sanitizeTableOfContents(
        [
          { title: "Introduction", level: 1, page: 1 },
          { title: "Background", level: 2, page: 3 },
        ],
        12
      )
    ).toEqual([
      { title: "Introduction", level: 1, page: 1 },
      { title: "Background", level: 2, page: 3 },
    ]);
  });

  it("clamps a page past the end of the document", () => {
    const [entry] = sanitizeTableOfContents(
      [{ title: "Appendix", level: 1, page: 99 }],
      12
    );
    expect(entry.page).toBe(12);
  });

  it("normalizes depth into a ladder", () => {
    // A level-4 entry after a level-1 would render as three phantom levels of
    // nesting; each entry may only go one deeper than the one before it.
    const levels = sanitizeTableOfContents(
      [
        { title: "A", level: 3, page: 1 },
        { title: "B", level: 4, page: 2 },
        { title: "C", level: 9, page: 3 },
        { title: "D", level: 0, page: 4 },
      ],
      10
    ).map((entry) => entry.level);
    expect(levels).toEqual([1, 2, 3, 1]);
  });

  it("drops untitled entries and survives junk", () => {
    expect(
      sanitizeTableOfContents(
        [
          { title: "  ", level: 1, page: 1 },
          { title: "Real", level: undefined, page: undefined },
        ],
        5
      )
    ).toEqual([{ title: "Real", level: 1, page: 1 }]);
    expect(sanitizeTableOfContents(undefined, 5)).toEqual([]);
  });

  it("does not clamp pages when the page count is unknown", () => {
    const [entry] = sanitizeTableOfContents(
      [{ title: "Section", level: 1, page: 40 }],
      undefined
    );
    expect(entry.page).toBe(40);
  });
});

describe("sanitizeDocumentDate", () => {
  // 2026-08-12, the reference "now" for the future-date checks below.
  const NOW = Date.UTC(2026, 7, 12);

  it("keeps a full date the document stated", () => {
    expect(
      sanitizeDocumentDate(
        { value: "2026-08-08", precision: "day", evidence: "Dated August 8, 2026" },
        NOW
      )
    ).toEqual({ documentDate: "2026-08-08", documentDatePrecision: "day" });
  });

  it("keeps month and year precision without padding them out", () => {
    expect(
      sanitizeDocumentDate({ value: "2026-08", precision: "month" }, NOW)
    ).toEqual({ documentDate: "2026-08", documentDatePrecision: "month" });
    expect(
      sanitizeDocumentDate({ value: "2019", precision: "year" }, NOW)
    ).toEqual({ documentDate: "2019", documentDatePrecision: "year" });
  });

  it("drops an explicit unknown", () => {
    expect(
      sanitizeDocumentDate({ value: "", precision: "unknown", evidence: "" }, NOW)
    ).toBeNull();
    expect(sanitizeDocumentDate(undefined, NOW)).toBeNull();
  });

  it("drops a value whose shape contradicts its stated precision", () => {
    // Claiming day precision on a bare year is the model contradicting
    // itself; picking a winner would be inventing the missing half.
    expect(
      sanitizeDocumentDate({ value: "2026", precision: "day" }, NOW)
    ).toBeNull();
    expect(
      sanitizeDocumentDate({ value: "2026-08-08", precision: "year" }, NOW)
    ).toBeNull();
  });

  it("drops anything that isn't an ISO prefix", () => {
    for (const value of ["August 8, 2026", "08/08/2026", "2026-8-8", "unknown", "n.d."]) {
      expect(sanitizeDocumentDate({ value, precision: "day" }, NOW)).toBeNull();
    }
  });

  it("drops an impossible calendar date", () => {
    expect(
      sanitizeDocumentDate({ value: "2026-02-31", precision: "day" }, NOW)
    ).toBeNull();
  });

  it("drops a date in the future", () => {
    // No document states a creation date it hasn't reached — a parse error or
    // a hallucination either way.
    expect(
      sanitizeDocumentDate({ value: "2027-01-01", precision: "day" }, NOW)
    ).toBeNull();
    expect(
      sanitizeDocumentDate({ value: "2030", precision: "year" }, NOW)
    ).toBeNull();
  });
});

describe("sanitizeDocumentPlace", () => {
  it("keeps a place the document stated, with its evidence", () => {
    expect(
      sanitizeDocumentPlace({
        value: "Geneva, Switzerland",
        evidence: "Done at Geneva, Switzerland, this 8th day of August",
      })
    ).toEqual({
      documentPlace: "Geneva, Switzerland",
      documentPlaceEvidence: "Done at Geneva, Switzerland, this 8th day of August",
    });
  });

  it("keeps a place with no evidence quote", () => {
    expect(sanitizeDocumentPlace({ value: "San Francisco County" })).toEqual({
      documentPlace: "San Francisco County",
      documentPlaceEvidence: undefined,
    });
  });

  it("collapses whitespace a line break left in the middle of a place", () => {
    expect(
      sanitizeDocumentPlace({ value: "  London,\n  England " })?.documentPlace
    ).toBe("London, England");
  });

  it("drops the refusal words Analyze reaches for instead of an empty value", () => {
    for (const value of ["Unknown", "n/a", "None", "not stated", "unspecified"]) {
      expect(sanitizeDocumentPlace({ value })).toBeNull();
    }
    expect(sanitizeDocumentPlace({ value: "" })).toBeNull();
    expect(sanitizeDocumentPlace(undefined)).toBeNull();
  });

  it("drops prose where a place name belongs", () => {
    // A sentence in this field is the model narrating rather than declining.
    expect(
      sanitizeDocumentPlace({
        value:
          "The document does not state where it was written, though it discusses properties in several counties across the state and refers to a filing office.",
      })
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  bodyTextSize,
  headingsFromGeometry,
  normalizeTitle,
  score,
  selfAgreement,
  titleSimilarity,
  type GeometryItem,
  type TocEntry,
} from "./toc";

const entry = (title: string, page: number, level = 1): TocEntry => ({
  title,
  level,
  page,
});

describe("normalizeTitle", () => {
  it("strips the section number one method emits and another does not", () => {
    expect(normalizeTitle("3.1 Scope of Work")).toBe("scope of work");
    expect(normalizeTitle("IV. Findings")).toBe("findings");
    expect(normalizeTitle("(a) Definitions")).toBe("definitions");
  });

  it("ignores case and punctuation", () => {
    expect(normalizeTitle("FINDINGS OF FACT:")).toBe(normalizeTitle("Findings of Fact"));
  });
});

describe("titleSimilarity", () => {
  it("is 1 for the same heading written differently", () => {
    expect(titleSimilarity("2. Scope", "Scope")).toBe(1);
  });

  it("is order-independent", () => {
    expect(titleSimilarity("Findings of Fact", "Fact Findings of")).toBe(1);
  });

  it("is 0 for unrelated headings", () => {
    expect(titleSimilarity("Appendix B", "Executive Summary")).toBe(0);
  });

  it("falls between for partial overlap", () => {
    const value = titleSimilarity("Scope of Work", "Scope of Services");
    expect(value).toBeGreaterThan(0.5);
    expect(value).toBeLessThan(1);
  });
});

describe("score", () => {
  const reference = [entry("Introduction", 1), entry("Findings", 4), entry("Order", 9)];

  it("credits a perfect candidate", () => {
    const result = score(reference, reference);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.pageExact).toBe(1);
  });

  it("separates a missed heading from a wrong page", () => {
    const result = score(reference, [
      entry("Introduction", 1),
      entry("Findings", 6), // right heading, wrong page
    ]);
    expect(result.matched).toBe(2);
    expect(result.recall).toBeCloseTo(2 / 3);
    expect(result.precision).toBe(1);
    expect(result.pageExact).toBe(0.5);
    expect(result.medianAbsPageDelta).toBe(1);
    expect(result.missed.map((e) => e.title)).toEqual(["Order"]);
  });

  it("counts invented headings against precision, not recall", () => {
    const result = score(reference, [
      ...reference,
      entry("Page 3 of 12", 3),
      entry("Exhibit stamp", 5),
    ]);
    expect(result.recall).toBe(1);
    expect(result.precision).toBeCloseTo(3 / 5);
    expect(result.spurious).toHaveLength(2);
  });

  it("does not let one candidate satisfy two reference entries", () => {
    const result = score([entry("Findings", 4), entry("Findings", 11)], [
      entry("Findings", 4),
    ]);
    expect(result.matched).toBe(1);
  });

  it("pairs a repeated heading with the nearer page", () => {
    const result = score([entry("Findings", 11)], [entry("Findings", 4), entry("Findings", 12)]);
    expect(result.matches[0].candidate.page).toBe(12);
  });

  it("handles an empty candidate without dividing by zero", () => {
    const result = score(reference, []);
    expect(result.recall).toBe(0);
    expect(result.precision).toBe(0);
    expect(result.f1).toBe(0);
  });
});

describe("selfAgreement", () => {
  it("is 1 for a method that repeats itself", () => {
    const run = [entry("Introduction", 1), entry("Findings", 4)];
    expect(selfAgreement([run, run, run])).toBe(1);
  });

  it("drops when runs disagree, as production's Analyze does", () => {
    const agreement = selfAgreement([
      [entry("Introduction", 1), entry("Findings", 4), entry("Order", 9)],
      [entry("Introduction", 1), entry("Findings", 4)],
      [entry("Introduction", 1), entry("Findings", 5), entry("Order", 9), entry("Appendix", 12)],
    ]);
    expect(agreement).toBeGreaterThan(0.5);
    expect(agreement).toBeLessThan(1);
  });
});

describe("headingsFromGeometry", () => {
  const body = (text: string, page: number, order: number): GeometryItem => ({
    text,
    size: 10,
    page,
    order,
    bold: false,
  });

  it("elects the body size by character volume, not line count", () => {
    const items = [
      { text: "TITLE", size: 24, page: 1, order: 700 },
      ...Array.from({ length: 3 }, (_, i) =>
        body("a fairly long line of ordinary body copy", 1, 600 - i * 20)
      ),
    ];
    expect(bodyTextSize(items)).toBe(10);
  });

  it("finds a large heading above body text", () => {
    const items: GeometryItem[] = [
      { text: "Findings of Fact", size: 18, page: 2, order: 700 },
      ...Array.from({ length: 6 }, (_, i) =>
        body("ordinary paragraph text that carries the document", 2, 600 - i * 20)
      ),
    ];
    const headings = headingsFromGeometry(items);
    expect(headings).toEqual([{ title: "Findings of Fact", level: 1, page: 2 }]);
  });

  it("assigns levels by size, largest first", () => {
    const items: GeometryItem[] = [
      { text: "Part One", size: 22, page: 1, order: 700 },
      { text: "Scope", size: 14, page: 1, order: 500 },
      ...Array.from({ length: 8 }, (_, i) =>
        body("ordinary paragraph text that carries the document", 1, 400 - i * 20)
      ),
    ];
    expect(headingsFromGeometry(items).map((h) => h.level)).toEqual([1, 2]);
  });

  it("returns nothing for a uniform-font document rather than guessing", () => {
    const items = Array.from({ length: 10 }, (_, i) => body("uniform line of text", 1, 500 - i * 20));
    expect(headingsFromGeometry(items)).toEqual([]);
  });

  it("refuses to call everything a heading", () => {
    const items: GeometryItem[] = Array.from({ length: 10 }, (_, i) => ({
      text: `Big line ${i}`,
      size: 20,
      page: 1,
      order: 500 - i * 20,
    }));
    // Every line is the same large size, so it becomes the body size and
    // nothing stands above it — the correct answer is no headings, not ten.
    expect(headingsFromGeometry(items)).toEqual([]);
  });

  it("keeps a long title that does not close a sentence", () => {
    const items: GeometryItem[] = [
      {
        text: "MEMORANDUM OF UNDERSTANDING BETWEEN THE CITY AND THE COUNTY REGARDING SHARED SERVICES",
        size: 18,
        page: 1,
        order: 700,
      },
      ...Array.from({ length: 8 }, (_, i) =>
        body("ordinary paragraph text that carries the document", 1, 600 - i * 20)
      ),
    ];
    expect(headingsFromGeometry(items)).toHaveLength(1);
  });

  it("ignores a long sentence that merely happens to be set large", () => {
    const items: GeometryItem[] = [
      {
        text: "This is a pull quote that runs on well past the length of anything anyone would call a heading, set large for emphasis.",
        size: 18,
        page: 1,
        order: 700,
      },
      ...Array.from({ length: 8 }, (_, i) =>
        body("ordinary paragraph text that carries the document", 1, 600 - i * 20)
      ),
    ];
    expect(headingsFromGeometry(items)).toEqual([]);
  });
});

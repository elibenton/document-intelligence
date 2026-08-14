import { describe, expect, it } from "vitest";
import { toCslItem } from "./cslItem";

const base = { _id: "d1", name: "scan_0042.pdf" };

describe("toCslItem", () => {
  it("titles the item by the library name, not the upload filename", () => {
    const item = toCslItem({ ...base, displayName: "Roe v. SFBSC Judgment" });
    expect(item.title).toBe("Roe v. SFBSC Judgment");
  });

  it("falls back to the filename when nothing has renamed it", () => {
    expect(toCslItem(base).title).toBe("scan_0042.pdf");
  });

  it("keeps an organization as a literal name rather than splitting it", () => {
    const item = toCslItem({
      ...base,
      citation: {
        type: "report",
        contributors: [
          { role: "author", literal: "California Department of Food and Agriculture" },
        ],
      },
    });
    expect(item.author).toEqual([
      { literal: "California Department of Food and Agriculture" },
    ]);
  });

  it("splits contributors by role", () => {
    const item = toCslItem({
      ...base,
      citation: {
        contributors: [
          { role: "author", family: "Berman", given: "Sheri" },
          { role: "editor", family: "Rao", given: "N." },
          { role: "translator", literal: "A Bureau" },
        ],
      },
    });
    expect(item.author).toEqual([{ family: "Berman", given: "Sheri" }]);
    expect(item.editor).toEqual([{ family: "Rao", given: "N." }]);
    expect(item.translator).toEqual([{ literal: "A Bureau" }]);
  });

  it("truncates issued to the precision the document actually established", () => {
    // A month-precision date must not become the first of that month, or a
    // style that prints full dates invents a day the document never stated.
    expect(toCslItem({ ...base, documentDate: "2013-01" }).issued).toEqual({
      "date-parts": [[2013, 1]],
    });
    expect(toCslItem({ ...base, documentDate: "2013" }).issued).toEqual({
      "date-parts": [[2013]],
    });
    expect(toCslItem({ ...base, documentDate: "2013-01-28" }).issued).toEqual({
      "date-parts": [[2013, 1, 28]],
    });
  });

  it("omits issued entirely when the document is undated", () => {
    expect(toCslItem(base).issued).toBeUndefined();
  });

  it("carries a legal case's authority without inventing a publisher", () => {
    const item = toCslItem({
      ...base,
      displayName: "Roe v. SFBSC Management Preliminary Approval Order",
      citation: {
        type: "legal_case",
        authority: "United States District Court Northern District of California",
        number: "14-cv-03616-LB",
      },
    });
    expect(item.type).toBe("legal_case");
    expect(item.authority).toBe(
      "United States District Court Northern District of California"
    );
    expect(item.publisher).toBeUndefined();
  });

  it("gives a web clip its URL and an access date", () => {
    const item = toCslItem({
      ...base,
      sourceUrl: "https://example.org/story",
      uploadedAt: Date.UTC(2026, 7, 14),
    });
    expect(item.type).toBe("webpage");
    expect(item.URL).toBe("https://example.org/story");
    expect(item.accessed).toEqual({ "date-parts": [[2026, 8, 14]] });
  });

  it("gives an uploaded file no access date, even when it prints a URL", () => {
    // `accessed` means when we fetched it. For a PDF someone handed over, the
    // upload time says nothing about the document.
    const item = toCslItem({
      ...base,
      uploadedAt: Date.UTC(2026, 7, 14),
      citation: { url: "www.foreignaffairs.com/permissions" },
    });
    expect(item.URL).toBe("www.foreignaffairs.com/permissions");
    expect(item.accessed).toBeUndefined();
  });

  it("emits the generic bucket as report, carrying the kind as genre", () => {
    // Not CSL "document": Chicago's bibliography has no layout for it and
    // renders nothing at all, which would drop the source from the list.
    const item = toCslItem({
      ...base,
      primaryKind: "preliminary approval order",
      displayName: "Roe v. SFBSC Judgment",
    });
    expect(item.type).toBe("report");
    expect(item.genre).toBe("preliminary approval order");
  });

  it("does not overwrite a real bibliographic type with the kind", () => {
    const item = toCslItem({
      ...base,
      primaryKind: "journal article",
      citation: { type: "article-journal", containerTitle: "Foreign Affairs" },
    });
    expect(item.type).toBe("article-journal");
    expect(item.genre).toBeUndefined();
  });

  it("drops empty fields rather than handing citeproc blanks to print", () => {
    const item = toCslItem({ ...base, citation: { publisher: "", volume: "" } });
    expect("publisher" in item).toBe(false);
    expect("volume" in item).toBe(false);
    expect("author" in item).toBe(false);
  });
});

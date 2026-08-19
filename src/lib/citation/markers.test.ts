import { describe, expect, it } from "vitest";
import { citationMarkdown, firstCitationNumber } from "./markers";

describe("citationMarkdown", () => {
  it("links a bare [n] marker", () => {
    expect(citationMarkdown("Owned by Carouba [5].", null, false)).toBe(
      "Owned by Carouba [\\[5\\]](#citation-5)."
    );
  });

  it("normalizes [Source n]", () => {
    expect(citationMarkdown("Owned by Carouba [Source 5].", null, false)).toBe(
      "Owned by Carouba [\\[5\\]](#citation-5)."
    );
  });

  it("splits a multi-number marker into one link per source", () => {
    expect(citationMarkdown("Both agree [Source 5, 6].", null, false)).toBe(
      "Both agree [\\[5\\]](#citation-5)[\\[6\\]](#citation-6)."
    );
    expect(citationMarkdown("All of them [1, 3, 14].", null, false)).toBe(
      "All of them [\\[1\\]](#citation-1)[\\[3\\]](#citation-3)[\\[14\\]](#citation-14)."
    );
  });

  it("handles the Known Facts prefix", () => {
    expect(
      citationMarkdown("Per the graph [Known Facts, Source 1].", null, false)
    ).toBe("Per the graph [\\[1\\]](#citation-1).");
  });

  it("leaves real markdown links alone", () => {
    const link = "see [an op-ed](https://example.com/op-ed)";
    expect(citationMarkdown(link, null, false)).toBe(link);
  });

  it("leaves non-citation brackets alone", () => {
    expect(citationMarkdown("[Known Facts] alone", null, false)).toBe(
      "[Known Facts] alone"
    );
  });
});

describe("firstCitationNumber", () => {
  it("reads the first number out of any marker shape", () => {
    expect(firstCitationNumber("text [Source 5, 6] more [2]")).toBe(5);
    expect(firstCitationNumber("text [3] more")).toBe(3);
  });

  it("returns null when nothing is cited", () => {
    expect(firstCitationNumber("no citations here")).toBeNull();
  });
});

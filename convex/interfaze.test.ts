import { describe, expect, it } from "vitest";
import { ocrPrecontextToPages } from "./interfaze";
import type { Precontext } from "interfaze";

/**
 * Build an OCR result in Interfaze's precontext shape.
 *
 * Whole-document results report the *stacked* height of every page, and one
 * section per page — so a 3-page letter-size scan reports height 4752, not
 * 1584. That is why the page-splitting code divides.
 */
function ocrResult(pageTexts: string[], pageHeight = 1584, width = 1224) {
  return {
    extracted_text: pageTexts.join("\n\n"),
    width,
    height: pageHeight * pageTexts.length,
    total_pages: pageTexts.length,
    sections: pageTexts.map((text, page) => ({
      text,
      lines: [
        {
          text,
          average_confidence: 0.99,
          bounds: {
            top_left: { x: 100, y: 100 + page * pageHeight },
            top_right: { x: 500, y: 100 + page * pageHeight },
            bottom_right: { x: 500, y: 130 + page * pageHeight },
            bottom_left: { x: 100, y: 130 + page * pageHeight },
          },
          words: text.split(" ").map((word, index) => ({
            text: word,
            confidence: 0.99,
            bounds: {
              top_left: { x: 100 + index * 60, y: 100 + page * pageHeight },
              top_right: { x: 155 + index * 60, y: 100 + page * pageHeight },
              bottom_right: { x: 155 + index * 60, y: 130 + page * pageHeight },
              bottom_left: { x: 100 + index * 60, y: 130 + page * pageHeight },
            },
          })),
        },
      ],
    })),
  };
}

const pre = (...results: unknown[]): Precontext[] =>
  results.map((result) => ({ name: "ocr", result }));

describe("ocrPrecontextToPages", () => {
  it("splits a single whole-document result into one page per section", () => {
    const pages = ocrPrecontextToPages(pre(ocrResult(["page one", "page two", "page three"])));

    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.text)).toEqual(["page one", "page two", "page three"]);
    // Stacked height (4752) must be divided back down to a real page.
    expect(pages[0].height).toBe(1584);
  });

  it("collapses repeated identical OCR results instead of reading them as pages", () => {
    // Regression: a single completion returned the same whole-document OCR
    // twice. Treating each repeat as a page merged every page's text onto
    // page 0, duplicated it onto page 1, and left page 2 blank — scoring 6.8%
    // text fidelity against the document's own embedded text layer.
    const once = ocrResult(["page one", "page two", "page three"]);
    const pages = ocrPrecontextToPages(pre(once, structuredClone(once)));

    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.text)).toEqual(["page one", "page two", "page three"]);
    expect(pages.every((p) => p.text.trim().length > 0)).toBe(true);
    expect(pages[0].height).toBe(1584);
  });

  it("treats one result per page as pages when the count matches total_pages", () => {
    const perPage = [0, 1, 2].map((index) => ({
      ...ocrResult([`page ${index}`]),
      total_pages: 3,
    }));
    const pages = ocrPrecontextToPages(pre(...perPage));

    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.text)).toEqual(["page 0", "page 1", "page 2"]);
  });

  it("prefers the most complete reading when entries disagree with the page count", () => {
    // Two distinct results, neither of which is a page: a partial read and a
    // complete one. Picking the first would silently truncate the document.
    const partial = ocrResult(["page one"]);
    const complete = ocrResult(["page one", "page two", "page three"]);
    const pages = ocrPrecontextToPages([
      { name: "ocr", result: { ...partial, total_pages: 3 } },
      { name: "ocr", result: complete },
    ]);

    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.text)).toEqual(["page one", "page two", "page three"]);
  });

  it("carries word-level geometry through, rebased onto each page", () => {
    const pages = ocrPrecontextToPages(pre(ocrResult(["alpha beta", "gamma delta"])));
    const words = pages[1].blocks[0].words ?? [];

    expect(words.map((w) => w.text)).toEqual(["gamma", "delta"]);
    for (const word of words) {
      expect(word.bbox).toBeDefined();
      expect(word.bbox!.width).toBeGreaterThan(0);
      expect(word.confidence).toBeCloseTo(0.99);
    }
  });

  it("never returns a page with blocks but no text", () => {
    // Regression: page text came from `section.text` while blocks came from
    // `section.lines`. A real upload returned sections whose text was missing,
    // producing 442 populated blocks across 12 pages that were all empty —
    // a document that rendered and highlighted but matched nothing in search.
    const withoutSectionText = ocrResult(["page one text", "page two text"]);
    for (const section of withoutSectionText.sections) {
      delete (section as { text?: string }).text;
    }

    const pages = ocrPrecontextToPages(pre(withoutSectionText));

    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.blocks.length).toBeGreaterThan(0);
      expect(page.text.trim()).not.toBe("");
      // The text must be exactly what the stored blocks say.
      expect(page.text).toBe(page.blocks.map((b) => b.text).join("\n"));
    }
  });

  it("falls back to section text when a section has no line geometry", () => {
    const textOnly = {
      total_pages: 1,
      width: 1224,
      height: 1584,
      sections: [{ text: "summary only, no lines" }],
    };

    const pages = ocrPrecontextToPages(pre(textOnly));

    expect(pages).toHaveLength(1);
    expect(pages[0].text).toBe("summary only, no lines");
  });

  it("returns nothing when precontext carries no OCR", () => {
    expect(ocrPrecontextToPages([])).toEqual([]);
    expect(
      ocrPrecontextToPages([{ name: "object_detection", result: { objects: [] } }])
    ).toEqual([]);
  });
});

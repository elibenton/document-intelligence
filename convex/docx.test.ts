import { describe, expect, it } from "vitest";
import {
  layoutDocument,
  parseDocumentXml,
  PAGE_MARGIN,
  PAGE_WIDTH,
  type MeasureText,
} from "./docx";

/** Deterministic stand-in for canvas metrics: every glyph is half an em wide. */
const measure: MeasureText = (text, fontPx) => text.length * fontPx * 0.5;

function wrapXml(body: string) {
  return `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
}

const paragraph = (text: string, properties = "") =>
  `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;

describe("parseDocumentXml", () => {
  it("reads text, headings, lists and entities", () => {
    const parsed = parseDocumentXml(
      wrapXml(
        paragraph("Title &amp; Subject", '<w:pStyle w:val="Heading1"/>') +
          paragraph("First item", '<w:numPr><w:ilvl w:val="0"/></w:numPr>') +
          paragraph("Body text")
      )
    );
    expect(parsed).toEqual([
      { text: "Title & Subject", style: "h1", listLevel: undefined, pageBreakBefore: false },
      { text: "First item", style: "body", listLevel: 0, pageBreakBefore: false },
      { text: "Body text", style: "body", listLevel: undefined, pageBreakBefore: false },
    ]);
  });

  it("keeps tabs and soft breaks but drops field instructions", () => {
    const parsed = parseDocumentXml(
      wrapXml(
        `<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r>` +
          `<w:r><w:instrText> PAGE </w:instrText></w:r></w:p>`
      )
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe("A\tB\nC");
  });

  it("splits a paragraph at a mid-paragraph page break", () => {
    const parsed = parseDocumentXml(
      wrapXml(
        `<w:p><w:r><w:t>before</w:t><w:br w:type="page"/><w:t>after</w:t></w:r></w:p>`
      )
    );
    expect(parsed.map((p) => [p.text, p.pageBreakBefore])).toEqual([
      ["before", false],
      ["after", true],
    ]);
  });

  it("treats Word's rendered page breaks as page boundaries", () => {
    const parsed = parseDocumentXml(
      wrapXml(
        paragraph("one") +
          `<w:p><w:r><w:lastRenderedPageBreak/><w:t>two</w:t></w:r></w:p>`
      )
    );
    expect(parsed[1]).toMatchObject({ text: "two", pageBreakBefore: true });
  });
});

describe("layoutDocument", () => {
  it("always yields at least one page, even for an empty document", () => {
    expect(layoutDocument([], measure)).toHaveLength(1);
  });

  it("starts a new page at an explicit break", () => {
    const pages = layoutDocument(
      [
        { text: "one", style: "body", pageBreakBefore: false },
        { text: "two", style: "body", pageBreakBefore: true },
      ],
      measure
    );
    expect(pages).toHaveLength(2);
    expect(pages[1].lines[0]).toMatchObject({ text: "two", y: PAGE_MARGIN });
  });

  it("wraps long text and overflows onto continuation pages", () => {
    const pages = layoutDocument(
      [{ text: "word ".repeat(4000).trim(), style: "body", pageBreakBefore: false }],
      measure
    );
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      for (const line of page.lines) {
        expect(line.x + line.width).toBeLessThanOrEqual(PAGE_WIDTH - PAGE_MARGIN + 1);
        expect(line.y + line.height).toBeLessThanOrEqual(page.height);
      }
    }
  });

  it("places word boxes left to right inside the line box", () => {
    const [page] = layoutDocument(
      [{ text: "alpha beta gamma", style: "body", pageBreakBefore: false }],
      measure
    );
    const [line] = page.lines;
    expect(line.words.map((word) => word.text)).toEqual(["alpha", "beta", "gamma"]);
    let previous = line.x - 1;
    for (const word of line.words) {
      expect(word.x).toBeGreaterThan(previous);
      expect(word.x + word.width).toBeLessThanOrEqual(line.x + line.width + 1);
      previous = word.x;
    }
  });

  it("renders a list paragraph with a bullet", () => {
    const [page] = layoutDocument(
      [{ text: "item", style: "body", listLevel: 0, pageBreakBefore: false }],
      measure
    );
    expect(page.lines[0].text).toBe("• item");
    expect(page.lines[0].x).toBeGreaterThan(PAGE_MARGIN);
  });
});

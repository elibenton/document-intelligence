import { describe, expect, it } from "vitest";
import { structuredContentToPages } from "./interfaze";

describe("structuredContentToPages", () => {
  it("turns required combined-response OCR into ingestible pages", () => {
    const pages = structuredContentToPages(
      JSON.stringify({
        pages: [
          { page_number: 1, text: "Primera página" },
          { page_number: 2, text: "Segunda página" },
          { page_number: 3, text: "Tercera página" },
        ],
        graphic_objects: [],
      })
    );

    expect(pages).toHaveLength(3);
    expect(pages[1]).toMatchObject({
      pageNumber: 1,
      text: "Segunda página",
      blocks: [
        {
          id: "p1_structured",
          block_type: "PageText",
          text: "Segunda página",
          page: 1,
        },
      ],
    });
  });

  it("preserves page positions when a provider omits an empty page", () => {
    const pages = structuredContentToPages(
      JSON.stringify({
        pages: [
          { page_number: 1, text: "One" },
          { page_number: 3, text: "Three" },
        ],
      })
    );

    expect(pages.map((page) => page.text)).toEqual(["One", "", "Three"]);
    expect(pages[1].blocks).toEqual([]);
  });

  it("rejects malformed or textless structured OCR", () => {
    expect(structuredContentToPages("not json")).toEqual([]);
    expect(
      structuredContentToPages(
        JSON.stringify({ pages: [{ page_number: 1, text: "" }] })
      )
    ).toEqual([]);
  });
});

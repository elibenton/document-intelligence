import { describe, expect, it } from "vitest";
import { buildSearchIndex, searchIndex } from "./blockSearch";
import type { TocBlock } from "./TableOfContents";

/** Blocks as the extractor actually emits them — see the failure classes in
 * each test's name; every one of these is copied from live document data. */
function doc(...texts: string[]): TocBlock[] {
  return texts.map((text, i) => ({
    _id: `b${i}` as TocBlock["_id"],
    text,
    pageNumber: 0,
    blockType: "Text",
  }));
}

const find = (blocks: TocBlock[], query: string) =>
  searchIndex(buildSearchIndex(blocks), query);

describe("searchBlocks", () => {
  it("matches a phrase that spans two blocks", () => {
    const blocks = doc("Third, and most concerning, is the", "allegation you make in paragraph seven");
    expect(find(blocks, "is the allegation you make").totalMatches).toBe(1);
  });

  it("matches across word-level blocks", () => {
    // A real document in this corpus has a median block length of 5 chars.
    const blocks = doc("el", "fuego", "mas", "grande");
    expect(find(blocks, "fuego mas grande").totalMatches).toBe(1);
  });

  it("matches where the line join lost its separator", () => {
    const blocks = doc("From: Public Records@CannabisTo: Public Records@Cannabis");
    expect(find(blocks, "Public Records@Cannabis To:").totalMatches).toBe(1);
  });

  it("matches across an embedded newline and indentation", () => {
    const blocks = doc("Lance H. Olson\n  Olson, Hagel &amp; Fishburn LLP");
    expect(find(blocks, "Olson Olson Hagel & Fishburn").totalMatches).toBe(1);
  });

  it("decodes entities rather than matching their letters", () => {
    const blocks = doc("Elliott, Nicole@Cannabis &lt;Nicole.Elliott@cannabis.ca.gov&gt;");
    expect(find(blocks, "<Nicole.Elliott@cannabis.ca.gov>").totalMatches).toBe(1);
    // "&lt;" must not survive normalization as the letters "lt".
    expect(find(blocks, "cannabislt").totalMatches).toBe(0);
  });

  it("ignores curly-vs-straight quotes and non-breaking spaces", () => {
    const blocks = doc("the Department’s mission and position");
    expect(find(blocks, "the Department's mission and position").totalMatches).toBe(1);
  });

  it("reports every occurrence, not one per block", () => {
    const blocks = doc("tax collection and", "more tax collection");
    expect(find(blocks, "tax collection").totalMatches).toBe(2);
  });

  it("attributes a hit to the block the match starts in", () => {
    const blocks = [
      { ...doc("Sincerely,Nicole")[0], pageNumber: 3 },
      { ...doc("Nicole ElliottDirector")[0], pageNumber: 4 },
    ];
    const hit = find(blocks, "Nicole Nicole Elliott").hits[0];
    expect(hit.pageNumber).toBe(3);
  });

  it("highlights the document's own spelling of the match", () => {
    const blocks = doc("Sincerely,Nicole");
    const hit = find(blocks, "Sincerely Nicole").hits[0];
    expect(hit.matchText).toBe("Sincerely,Nicole");
    expect(hit.snippet).toContain(hit.matchText);
  });

  it("rejects a query with too little to match on", () => {
    expect(find(doc("some text here"), "  ,  ").totalMatches).toBe(0);
    expect(find(doc("some text here"), "e").totalMatches).toBe(0);
  });
});

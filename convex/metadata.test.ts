import { describe, expect, it } from "vitest";
import { sanitizeTableOfContents } from "./metadata";

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

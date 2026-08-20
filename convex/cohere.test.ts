import { describe, expect, it } from "vitest";
import { insertCitationMarkers } from "./cohere";

// The shape a real Command A+ response takes (probed 2026-08-19): a thinking
// block precedes the text block, and citation offsets index into their own
// block via content_index.
const THINKING = { type: "thinking", thinking: "…" };

function textBlock(text: string) {
  return { type: "text", text };
}

function cite(
  start: number,
  end: number,
  ids: string[],
  content_index = 1
) {
  return {
    start,
    end,
    content_index,
    sources: ids.map((id) => ({ type: "document", id, document: { id } })),
  };
}

describe("insertCitationMarkers", () => {
  it("marks span ends with the cited source numbers", () => {
    const out = insertCitationMarkers(
      [THINKING, textBlock("Paid by Meridian on March 4, 2019.")],
      [cite(8, 16, ["1"]), cite(20, 33, ["2"])]
    );
    expect(out).toBe("Paid by Meridian[1] on March 4, 2019[2].");
  });

  it("merges sources at one offset, sorted and deduped", () => {
    const out = insertCitationMarkers(
      [THINKING, textBlock("Paid by Meridian.")],
      [cite(8, 16, ["3", "1"]), cite(8, 16, ["1"])]
    );
    expect(out).toBe("Paid by Meridian[1][3].");
  });

  it("skips non-numeric ids (the facts pseudo-document) but keeps the rest", () => {
    const out = insertCitationMarkers(
      [THINKING, textBlock("Lease signed 2018. Invoice paid.")],
      [cite(13, 17, ["facts"]), cite(27, 31, ["facts", "2"])]
    );
    expect(out).toBe("Lease signed 2018. Invoice paid[2].");
  });

  it("treats offsets as block-relative and missing content_index as joined-text", () => {
    const twoTexts = [textBlock("One. "), textBlock("Two.")];
    expect(
      insertCitationMarkers(twoTexts, [cite(0, 3, ["1"], 1)])
    ).toBe("One. Two[1].");
    expect(
      insertCitationMarkers(
        [THINKING, textBlock("One. Two.")],
        [{ start: 5, end: 8, sources: [{ id: "1" }] }]
      )
    ).toBe("One. Two[1].");
  });

  it("clamps out-of-range offsets and survives no citations at all", () => {
    expect(
      insertCitationMarkers(
        [textBlock("Short.")],
        [cite(0, 999, ["1"], 0)]
      )
    ).toBe("Short.[1]");
    expect(insertCitationMarkers([THINKING, textBlock("Plain.")], [])).toBe(
      "Plain."
    );
  });
});

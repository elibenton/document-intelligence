import { describe, expect, it } from "vitest";
import {
  buildNameIndex,
  findNameOccurrences,
  matchedBlockIndexes,
  normalizeName,
} from "./nameMatch";

describe("normalizeName", () => {
  it("drops punctuation, whitespace and case", () => {
    expect(normalizeName("Nicole  Elliott")).toBe("nicoleelliott");
    expect(normalizeName("O’Brien, J.")).toBe("obrienj");
  });

  it("decodes HTML entities before filtering", () => {
    expect(normalizeName("&lt;Nicole&gt;")).toBe("nicole");
  });
});

describe("findNameOccurrences", () => {
  it("matches a plain occurrence", () => {
    const index = buildNameIndex(["Hey there, Eli."]);
    const hits = findNameOccurrences(index, ["Eli"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].blockIndex).toBe(0);
  });

  it("never matches inside a word", () => {
    const index = buildNameIndex(["I believe this is gentlemanly."]);
    expect(findNameOccurrences(index, ["Eli"])).toHaveLength(0);
  });

  it("matches through punctuation, as search does", () => {
    const index = buildNameIndex(["From: <Nicole.Elliott@ca.gov>"]);
    expect(findNameOccurrences(index, ["Nicole Elliott"])).toHaveLength(1);
  });

  it("matches across a block boundary", () => {
    const index = buildNameIndex(["…was signed by Nicole", "Elliott on Tuesday"]);
    const hits = findNameOccurrences(index, ["Nicole Elliott"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].blockIndex).toBe(0); // starts in the first block
  });

  it("matches a hyphenated line wrap", () => {
    const index = buildNameIndex(["the testimony of Nicole El-\nliott before"]);
    expect(findNameOccurrences(index, ["Nicole Elliott"])).toHaveLength(1);
  });

  it("requires the boundary on both sides", () => {
    const index = buildNameIndex(["the DPAs were filed by DPA staff"]);
    // "DPAs" is not an occurrence of "DPA"; "DPA staff" is one.
    expect(findNameOccurrences(index, ["DPA"])).toHaveLength(1);
  });

  it("tries aliases and reports which variant hit", () => {
    const index = buildNameIndex(["Hello. Hey there, Eli."]);
    const hits = findNameOccurrences(index, ["Eli Cohen", "Eli"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].variant).toBe("Eli");
  });

  it("dedupes variants by normalized form, first spelling wins", () => {
    const index = buildNameIndex(["ELLIOTT was present"]);
    const hits = findNameOccurrences(index, ["Elliott", "ELLIOTT"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].variant).toBe("Elliott");
  });

  it("skips one-character variants", () => {
    const index = buildNameIndex(["A a a everywhere"]);
    expect(findNameOccurrences(index, ["A"])).toHaveLength(0);
  });

  it("reports in-block character offsets against the decoded text", () => {
    const text = "Dear Nicole Elliott,";
    const index = buildNameIndex([text]);
    const [hit] = findNameOccurrences(index, ["Nicole Elliott"]);
    expect(text.slice(hit.start, hit.end)).toBe("Nicole Elliott");
  });
});

describe("matchedBlockIndexes", () => {
  it("unions variants and dedupes by block", () => {
    const index = buildNameIndex([
      "Nicole Elliott spoke first.",
      "Later, Elliott disagreed.",
      "Nothing relevant here.",
    ]);
    const blocks = matchedBlockIndexes(index, ["Nicole Elliott", "Elliott"]);
    expect([...blocks].sort()).toEqual([0, 1]);
  });
});

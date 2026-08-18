import { describe, expect, it } from "vitest";
import { findActive } from "./transcriptAnchors";

const seg = (startTime: number, endTime: number, wordStarts: number[]) => ({
  startTime,
  endTime,
  words: wordStarts.map((start) => ({ start })),
});

const segments = [
  seg(0, 4, [0, 1, 2, 3]),
  seg(5, 9, [5, 6.5, 8]),
  seg(12, 20, [12, 15, 18]),
];

describe("findActive", () => {
  it("finds the word under the playhead", () => {
    expect(findActive(segments, 1.5)).toEqual({ segment: 0, word: 1 });
    expect(findActive(segments, 6.9)).toEqual({ segment: 1, word: 1 });
  });

  it("claims the gap up to the next segment's start", () => {
    // 4..5 is silence after segment 0 ends; the just-spoken turn keeps it.
    expect(findActive(segments, 4.5)).toEqual({ segment: 0, word: 3 });
  });

  it("lets the last segment claim past its end", () => {
    // Same rule the original linear scan used: the final turn has no
    // successor, so it stays active through the tail of the recording —
    // playback ending on a highlighted last word, not on nothing.
    expect(findActive(segments, 25)).toEqual({ segment: 2, word: 2 });
  });

  it("goes inactive before the first segment", () => {
    expect(findActive([seg(3, 5, [3])], 1)).toEqual({ segment: -1, word: -1 });
  });

  it("handles a segment with no words", () => {
    expect(findActive([seg(0, 2, [])], 1)).toEqual({ segment: 0, word: -1 });
  });

  it("handles empty input", () => {
    expect(findActive([], 0)).toEqual({ segment: -1, word: -1 });
  });

  it("matches exact word boundaries", () => {
    expect(findActive(segments, 6.5)).toEqual({ segment: 1, word: 1 });
    expect(findActive(segments, 5)).toEqual({ segment: 1, word: 0 });
  });
});

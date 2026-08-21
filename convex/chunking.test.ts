import { describe, expect, it } from "vitest";
import {
  applySpeakerNames,
  chunkPageText,
  chunkTranscriptSegments,
  embeddingText,
  PAGE_TARGET_CHARS,
  type TranscriptSegmentInput,
} from "./chunking";

const sentence = (n: number) => `Sentence number ${n} about the Geneva account. `;
const paragraphs = (n: number) =>
  Array.from({ length: n }, (_, i) => sentence(i).repeat(3).trim()).join("\n\n");

describe("chunkPageText", () => {
  it("returns nothing for an empty or blank page", () => {
    expect(chunkPageText("")).toEqual([]);
    expect(chunkPageText("   \n\n \t ")).toEqual([]);
  });

  it("keeps a short page as one chunk", () => {
    const text = "A single short paragraph.";
    expect(chunkPageText(text)).toEqual([
      { text, startChar: 0, endChar: text.length },
    ]);
  });

  // The invariant the block-mapping in A7 depends on: an offset pair must
  // address exactly the text it claims to, or a citation boxes the wrong lines.
  it("round-trips offsets against the source", () => {
    const text = paragraphs(30);
    for (const chunk of chunkPageText(text)) {
      expect(text.slice(chunk.startChar, chunk.endChar)).toBe(chunk.text);
    }
  });

  it("emits chunks in order, and covers the page", () => {
    const text = paragraphs(30);
    const chunks = chunkPageText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startChar).toBeGreaterThan(chunks[i - 1].startChar);
    }
    expect(chunks[0].startChar).toBe(0);
    expect(chunks[chunks.length - 1].endChar).toBe(text.length);
  });

  it("overlaps adjacent chunks, and only adjacent ones", () => {
    const chunks = chunkPageText(paragraphs(30));
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startChar).toBeLessThan(chunks[i - 1].endChar);
      if (i >= 2) {
        expect(chunks[i].startChar).toBeGreaterThanOrEqual(chunks[i - 2].endChar);
      }
    }
  });

  it("never leaves leading or trailing whitespace on a chunk", () => {
    for (const chunk of chunkPageText(paragraphs(20))) {
      expect(chunk.text).toBe(chunk.text.trim());
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("breaks on a paragraph seam when one is in range", () => {
    const head = "x".repeat(PAGE_TARGET_CHARS - 200);
    const text = `${head}\n\n${"y".repeat(PAGE_TARGET_CHARS)}`;
    const [first] = chunkPageText(text);
    expect(first.text).toBe(head);
  });

  it("cuts a single unbroken run rather than growing without bound", () => {
    const text = "z".repeat(PAGE_TARGET_CHARS * 3);
    const chunks = chunkPageText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(PAGE_TARGET_CHARS);
    }
  });

  it("terminates when the overlap is as wide as the target", () => {
    const chunks = chunkPageText("word ".repeat(400), {
      targetChars: 100,
      overlapChars: 100,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1].endChar).toBeGreaterThan(0);
  });

  it("handles a sentence longer than the target", () => {
    const text = `${"a".repeat(PAGE_TARGET_CHARS + 500)}. Short tail.`;
    const chunks = chunkPageText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(text.slice(chunks[0].startChar, chunks[0].endChar)).toBe(chunks[0].text);
  });
});

const seg = (
  i: number,
  over: Partial<TranscriptSegmentInput> = {}
): TranscriptSegmentInput => ({
  speaker: "Speaker 1",
  text: `Turn ${i} of the interview.`,
  start: i * 10,
  end: i * 10 + 9,
  ...over,
});

describe("chunkTranscriptSegments", () => {
  it("returns nothing for no segments", () => {
    expect(chunkTranscriptSegments([])).toEqual([]);
  });

  it("keeps a single segment as one chunk", () => {
    const chunks = chunkTranscriptSegments([seg(0)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startTime).toBe(0);
    expect(chunks[0].endTime).toBe(9);
  });

  // A half-segment has no anchor a person can be sent to: the word timings
  // the player seeks by live on the whole row.
  it("never splits a segment, even one longer than both budgets", () => {
    const long = seg(0, { text: "w ".repeat(2000), start: 0, end: 600 });
    const chunks = chunkTranscriptSegments([long]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("w w");
    expect(chunks[0].endTime).toBe(600);
  });

  it("closes a window on the character budget", () => {
    const segments = Array.from({ length: 20 }, (_, i) =>
      seg(i, { text: "x".repeat(300), start: i, end: i + 1 })
    );
    const chunks = chunkTranscriptSegments(segments, { targetSeconds: 10_000 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("closes a window on the duration budget", () => {
    const segments = Array.from({ length: 10 }, (_, i) =>
      seg(i, { text: "hi", start: i * 60, end: i * 60 + 59 })
    );
    const chunks = chunkTranscriptSegments(segments, { targetChars: 100_000 });
    expect(chunks).toHaveLength(10);
  });

  it("carries speaker attribution into the text", () => {
    const chunks = chunkTranscriptSegments([
      seg(0, { speaker: "Kessler", text: "I signed it." }),
      seg(1, { speaker: "Reporter", text: "When?" }),
    ]);
    expect(chunks[0].text).toBe("Kessler: I signed it.\nReporter: When?");
  });

  it("spans times from the first segment's start to the last one's end", () => {
    const chunks = chunkTranscriptSegments(
      [seg(0), seg(1), seg(2)],
      { targetChars: 100_000, targetSeconds: 10_000 }
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startTime).toBe(0);
    expect(chunks[0].endTime).toBe(29);
    expect(chunks[0].segmentStart).toBe(0);
    expect(chunks[0].segmentEnd).toBe(2);
  });

  it("skips blank segments without opening a window for them", () => {
    const chunks = chunkTranscriptSegments([seg(0, { text: "   " }), seg(1)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Speaker 1: Turn 1 of the interview.");
  });
});

describe("embeddingText", () => {
  it("prefixes a title with its descriptors", () => {
    expect(embeddingText({ title: "Wire memo", kind: "memo", date: "2019-03" }, "body")).toBe(
      "Wire memo — memo, 2019-03\n\nbody"
    );
  });

  it("names the speaker for a recording", () => {
    expect(
      embeddingText({ title: "Interview", speaker: "Charles Kessler" }, "body")
    ).toBe("Interview\nSpeaker: Charles Kessler\n\nbody");
  });

  it("returns the passage unchanged when the document said nothing", () => {
    expect(embeddingText({}, "body")).toBe("body");
    expect(embeddingText({ title: "  ", author: null }, "body")).toBe("body");
  });

  it("is deterministic — same context, same bytes", () => {
    const context = { title: "A", kind: "b", date: "2020", author: "c" };
    expect(embeddingText(context, "x")).toBe(embeddingText({ ...context }, "x"));
  });
});

describe("applySpeakerNames", () => {
  const names = new Map([["Speaker 1", "Charles Kessler"]]);

  it("rewrites a known label, leaving the rest of the line alone", () => {
    expect(applySpeakerNames("Speaker 1: I signed it.", names)).toBe(
      "Charles Kessler: I signed it."
    );
  });

  it("leaves an unnamed label as the diarizer wrote it", () => {
    expect(applySpeakerNames("Speaker 2: When?", names)).toBe("Speaker 2: When?");
  });

  it("rewrites every line of a multi-speaker window", () => {
    expect(
      applySpeakerNames("Speaker 1: Yes.\nSpeaker 2: When?\nSpeaker 1: March.", names)
    ).toBe("Charles Kessler: Yes.\nSpeaker 2: When?\nCharles Kessler: March.");
  });

  it("does not touch a colon inside the spoken text", () => {
    expect(applySpeakerNames("Speaker 1: the ratio was 3: 1.", names)).toBe(
      "Charles Kessler: the ratio was 3: 1."
    );
  });

  it("is a no-op with nothing named", () => {
    const text = "Speaker 1: I signed it.";
    expect(applySpeakerNames(text, new Map())).toBe(text);
  });
});

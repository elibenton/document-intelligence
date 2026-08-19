import { describe, expect, it } from "vitest";
import {
  buildNativePageBlocks,
  summarizePageOps,
  type NativeTextItem,
  type PageOpCodes,
} from "./pdfNativeItems";

// A letter page's scale-1 viewport transform: y flipped, origin top-left.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const VIEWPORT = [1, 0, 0, -1, 0, PAGE_HEIGHT];

/** A pdf.js-style item: 12pt text with its baseline at PDF-space y. */
function item(
  str: string,
  x: number,
  pdfY: number,
  width: number,
  fontSize = 12
): NativeTextItem {
  return { str, transform: [fontSize, 0, 0, fontSize, x, pdfY], width };
}

describe("buildNativePageBlocks", () => {
  it("converts items to top-left boxes in viewport space", () => {
    const { blocks, text, geometryScore } = buildNativePageBlocks(
      [item("Hello", 100, 700, 30)],
      VIEWPORT,
      PAGE_WIDTH,
      PAGE_HEIGHT
    );
    expect(text).toBe("Hello");
    expect(geometryScore).toBe(1);
    expect(blocks).toHaveLength(1);
    // Baseline at PDF y=700 → viewport y=92; the box spans one font height up.
    expect(blocks[0].bbox).toEqual({ x: 100, y: 80, width: 30, height: 12 });
  });

  it("groups runs on one baseline into a line, in x order", () => {
    const { blocks, text } = buildNativePageBlocks(
      [
        item("world", 140, 700, 32),
        item("Hello", 100, 700, 30),
        item("Below", 100, 650, 34),
      ],
      VIEWPORT,
      PAGE_WIDTH,
      PAGE_HEIGHT
    );
    expect(blocks.map((block) => block.text)).toEqual([
      "Hello world",
      "Below",
    ]);
    expect(text).toBe("Hello world\nBelow");
  });

  it("splits a run into words with proportional boxes", () => {
    // "ab cd" over 50 units: 10 units per character.
    const { blocks } = buildNativePageBlocks(
      [item("ab cd", 100, 700, 50)],
      VIEWPORT,
      PAGE_WIDTH,
      PAGE_HEIGHT
    );
    const words = blocks[0].words!;
    expect(words.map((word) => word.text)).toEqual(["ab", "cd"]);
    expect(words[0].bbox).toEqual({ x: 100, y: 80, width: 20, height: 12 });
    expect(words[1].bbox).toEqual({ x: 130, y: 80, width: 20, height: 12 });
  });

  it("rejoins a word split across two touching runs", () => {
    // "Hay" + "stack" back to back with no gap: one word.
    const { blocks } = buildNativePageBlocks(
      [item("Hay", 100, 700, 21), item("stack", 121, 700, 35)],
      VIEWPORT,
      PAGE_WIDTH,
      PAGE_HEIGHT
    );
    expect(blocks[0].words!.map((word) => word.text)).toEqual(["Haystack"]);
    expect(blocks[0].text).toBe("Haystack");
  });

  it("scores geometry by the characters that landed on the page", () => {
    const { geometryScore, blocks } = buildNativePageBlocks(
      [
        item("good", 100, 700, 24),
        // Off the page entirely: counted against the score, box dropped.
        item("lost", 5_000, 700, 24),
      ],
      VIEWPORT,
      PAGE_WIDTH,
      PAGE_HEIGHT
    );
    expect(geometryScore).toBe(0.5);
    expect(blocks.map((block) => block.text)).toEqual(["good"]);
  });

  it("handles a page with no usable items", () => {
    expect(
      buildNativePageBlocks([], VIEWPORT, PAGE_WIDTH, PAGE_HEIGHT)
    ).toEqual({ blocks: [], text: "", geometryScore: 1 });
    expect(
      buildNativePageBlocks(
        [item("   ", 100, 700, 10)],
        VIEWPORT,
        PAGE_WIDTH,
        PAGE_HEIGHT
      )
    ).toEqual({ blocks: [], text: "", geometryScore: 1 });
  });

  it("boxes rotated text by its swept corners", () => {
    // 90°-rotated 12pt text: baseline runs up the page in viewport space.
    const rotated: NativeTextItem = {
      str: "Side",
      transform: [0, 12, -12, 0, 100, 700],
      width: 40,
    };
    const { blocks } = buildNativePageBlocks(
      [rotated],
      VIEWPORT,
      PAGE_WIDTH,
      PAGE_HEIGHT
    );
    // Viewport origin (100, 92), direction (0, -1), up (-1, 0) → the box
    // extends 40 up the page and 12 leftward from the baseline.
    expect(blocks[0].bbox).toEqual({ x: 88, y: 52, width: 12, height: 40 });
  });
});

const CODES: PageOpCodes = {
  setTextRenderingMode: 1,
  showText: 2,
  showSpacedText: 3,
  nextLineShowText: 4,
  nextLineSetSpacingShowText: 5,
  paintImageXObject: 6,
  paintImageMaskXObject: 7,
  transform: 8,
  save: 9,
  restore: 10,
};

function ops(entries: [number, unknown?][]) {
  return {
    fnArray: entries.map(([op]) => op),
    argsArray: entries.map(([, args]) => args),
  };
}

describe("summarizePageOps", () => {
  it("counts visible text and no images on a plain page", () => {
    expect(
      summarizePageOps(ops([[CODES.showText]]), CODES, PAGE_WIDTH, PAGE_HEIGHT)
    ).toEqual({
      visibleTextRuns: 1,
      hiddenTextRuns: 0,
      hasImage: false,
      fullPageImage: false,
    });
  });

  it("flags mode-3 text as hidden — the searchable-scan underlay", () => {
    const summary = summarizePageOps(
      ops([
        [CODES.setTextRenderingMode, [3]],
        [CODES.showText],
        [CODES.setTextRenderingMode, [0]],
        [CODES.showText],
      ]),
      CODES,
      PAGE_WIDTH,
      PAGE_HEIGHT
    );
    expect(summary.hiddenTextRuns).toBe(1);
    expect(summary.visibleTextRuns).toBe(1);
  });

  it("detects a page-sized image through the transform stack", () => {
    const summary = summarizePageOps(
      ops([
        [CODES.save],
        [CODES.transform, [PAGE_WIDTH, 0, 0, PAGE_HEIGHT, 0, 0]],
        [CODES.paintImageXObject, ["img"]],
        [CODES.restore],
        [CODES.transform, [40, 0, 0, 40, 0, 0]],
        [CODES.paintImageXObject, ["logo"]],
      ]),
      CODES,
      PAGE_WIDTH,
      PAGE_HEIGHT
    );
    expect(summary.fullPageImage).toBe(true);
    expect(summary.hasImage).toBe(true);
  });

  it("treats a small image as an image but not as coverage", () => {
    const summary = summarizePageOps(
      ops([
        [CODES.transform, [40, 0, 0, 40, 0, 0]],
        [CODES.paintImageXObject, ["logo"]],
      ]),
      CODES,
      PAGE_WIDTH,
      PAGE_HEIGHT
    );
    expect(summary.hasImage).toBe(true);
    expect(summary.fullPageImage).toBe(false);
  });
});

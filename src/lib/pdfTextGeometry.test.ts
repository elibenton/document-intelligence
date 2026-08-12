import { describe, expect, it } from "vitest";
import {
  buildPageTextTokens,
  separatorText,
  type TextBlock,
} from "./pdfTextGeometry";

const block = (
  id: string,
  text: string,
  x: number,
  y: number,
  width: number,
  height = 12
): TextBlock => ({
  _id: id,
  blockId: id,
  text,
  bbox: { x, y, width, height },
});

describe("buildPageTextTokens", () => {
  it("uses word boxes instead of a line-wide selection rectangle", () => {
    const tokens = buildPageTextTokens(
      [{
        ...block("line", "Alpha beta", 10, 20, 300),
        words: [
          { text: "Alpha", bbox: { x: 10, y: 20, width: 45, height: 12 } },
          { text: "beta", bbox: { x: 65, y: 20, width: 35, height: 12 } },
        ],
      }],
      600,
      800
    );

    expect(tokens.map((token) => token.text)).toEqual(["Alpha", "beta"]);
    expect(tokens.map((token) => token.bbox.width)).toEqual([45, 35]);
    expect(tokens[1].separatorBefore).toBe("space");
  });

  it("reads a two-column page down the left column before the right", () => {
    const tokens = buildPageTextTokens(
      [
        block("right-2", "R2", 360, 140, 40),
        block("left-1", "L1", 40, 100, 40),
        block("header", "Full width heading", 80, 30, 440, 20),
        block("right-1", "R1", 360, 100, 40),
        block("left-2", "L2", 40, 140, 40),
      ],
      600,
      800
    );

    expect(tokens.map((token) => token.text)).toEqual([
      "Full width heading",
      "L1",
      "L2",
      "R1",
      "R2",
    ]);
  });

  it("detects newspaper columns separated by a narrow persistent gutter", () => {
    const blocks = Array.from({ length: 6 }, (_, row) => [
      block(`left-${row}`, `Left ${row}`, 20, 100 + row * 24, 272),
      block(`right-${row}`, `Right ${row}`, 308, 100 + row * 24, 272),
    ]).flat();
    const tokens = buildPageTextTokens(blocks, 600, 800);

    expect(tokens.map((token) => token.text)).toEqual([
      "Left 0",
      "Left 1",
      "Left 2",
      "Left 3",
      "Left 4",
      "Left 5",
      "Right 0",
      "Right 1",
      "Right 2",
      "Right 3",
      "Right 4",
      "Right 5",
    ]);
  });

  it("rejects corrupt off-page geometry", () => {
    const tokens = buildPageTextTokens(
      [
        block("valid", "Visible", 20, 20, 80),
        block("hidden", "Artifact", -400, 20, 30),
        block("zero", "Zero", 0, 0, 0),
      ],
      600,
      800
    );

    expect(tokens.map((token) => token.text)).toEqual(["Visible"]);
  });

  it("orders single-column input geometrically and preserves punctuation", () => {
    const tokens = buildPageTextTokens(
      [
        block("world", "world", 80, 20, 45),
        block("next", "Next", 20, 50, 35),
        block("comma", ",", 67, 20, 5),
        block("hello", "Hello", 20, 20, 40),
      ],
      600,
      800
    );
    const text = tokens
      .map((token) => separatorText(token.separatorBefore) + token.text)
      .join("");

    expect(text).toBe("Hello, world\nNext");
  });
});

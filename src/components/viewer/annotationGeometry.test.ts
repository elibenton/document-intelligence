import { describe, expect, it } from "vitest";
import { boundingRect, mergeSelectionRects } from "./annotationGeometry";

const word = (x: number, width: number, y = 100, height = 10) => ({
  x,
  y,
  width,
  height,
});

describe("mergeSelectionRects", () => {
  it("closes the gaps between words on one line", () => {
    expect(
      mergeSelectionRects([word(10, 30), word(44, 20), word(68, 25)])
    ).toEqual([word(10, 83)]);
  });

  it("keeps a wide gutter as two runs", () => {
    const merged = mergeSelectionRects([word(10, 30), word(300, 40)]);
    expect(merged).toEqual([word(10, 30), word(300, 40)]);
  });

  it("emits one run per line for a multi-line selection", () => {
    const merged = mergeSelectionRects([
      word(10, 30, 100),
      word(44, 20, 100),
      word(10, 50, 116),
    ]);
    expect(merged).toEqual([word(10, 54, 100), word(10, 50, 116)]);
  });

  it("grows a run to cover a taller word on the same line", () => {
    const merged = mergeSelectionRects([
      word(10, 30, 100, 10),
      word(44, 20, 96, 14),
    ]);
    expect(merged).toEqual([{ x: 10, y: 96, width: 54, height: 14 }]);
  });

  it("drops zero-area boxes rather than drawing invisible slivers", () => {
    expect(mergeSelectionRects([word(10, 0), word(20, 0, 100, 0)])).toEqual([]);
  });

  it("returns nothing for an empty selection", () => {
    expect(mergeSelectionRects([])).toEqual([]);
  });
});

describe("boundingRect", () => {
  it("spans every rect it is given", () => {
    expect(
      boundingRect([word(10, 30, 100), word(5, 50, 116)])
    ).toEqual({ x: 5, y: 100, width: 50, height: 26 });
  });

  it("has nothing to anchor to when there are no rects", () => {
    expect(boundingRect([])).toBeNull();
  });
});

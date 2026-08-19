import { describe, expect, it } from "vitest";
import {
  LEFT_MIN_WIDTH,
  SIDEBAR_MIN_WIDTH,
  resolvePanels,
} from "./panelLayout";
import { MIN_ZOOM, PANEL_ZOOM_FLOOR, VIEWER_MIN_WIDTH } from "./zoom";

const BASE = {
  hasLeft: true,
  leftPreferred: 300,
  sidebarPreferred: 380,
  leftHidden: false,
  sidebarHidden: false,
  leftPinned: false,
  sidebarPinned: false,
};

const at = (containerWidth: number, overrides = {}) =>
  resolvePanels({ ...BASE, containerWidth, ...overrides });

/** Narrowest window that still fits both panels at their preferred widths.
 *  The resize handles are overlays, so no gutters enter the math. */
const ROOMY = VIEWER_MIN_WIDTH + 300 + 380;
/** Narrowest window that still fits both panels at their minimums. */
const BOTH_AT_MIN = VIEWER_MIN_WIDTH + LEFT_MIN_WIDTH + SIDEBAR_MIN_WIDTH;

describe("resolvePanels", () => {
  it("leaves both panels at their preferred widths when there is room", () => {
    const layout = at(ROOMY + 400);
    expect(layout).toMatchObject({
      leftWidth: 300,
      sidebarWidth: 380,
      leftCollapsed: false,
      sidebarCollapsed: false,
      zoomFloor: PANEL_ZOOM_FLOOR,
    });
    expect(layout.viewerWidth).toBe(ROOMY + 400 - 680);
  });

  it("holds the page at the panel floor before shrinking the panels", () => {
    // The viewer keeps VIEWER_MIN_WIDTH — enough for a page at the floor —
    // while the panels absorb the loss.
    const layout = at(ROOMY - 100);
    expect(layout.leftWidth).toBeLessThan(300);
    expect(layout.sidebarWidth).toBeLessThan(380);
    expect(layout.viewerWidth).toBe(VIEWER_MIN_WIDTH);
    expect(layout.zoomFloor).toBe(PANEL_ZOOM_FLOOR);
  });

  it("shrinks both panels together rather than one at a time", () => {
    const layout = at(ROOMY - 100);
    const leftGiven = (300 - layout.leftWidth) / (300 - LEFT_MIN_WIDTH);
    const sidebarGiven =
      (380 - layout.sidebarWidth) / (380 - SIDEBAR_MIN_WIDTH);
    // Widths are rounded to whole pixels, so the two fractions land within a
    // percent of each other rather than exactly equal.
    expect(leftGiven).toBeCloseTo(sidebarGiven, 1);
  });

  it("stops shrinking the panels at their minimum widths", () => {
    const layout = at(BOTH_AT_MIN);
    expect(layout.leftWidth).toBe(LEFT_MIN_WIDTH);
    expect(layout.sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(layout.leftCollapsed).toBe(false);
    expect(layout.sidebarCollapsed).toBe(false);
  });

  it("folds the left panel away once the minimums no longer fit", () => {
    const layout = at(BOTH_AT_MIN - 1);
    expect(layout.leftCollapsed).toBe(true);
    expect(layout.leftForced).toBe(true);
    expect(layout.sidebarCollapsed).toBe(false);
    // The right panel gets the room the left one gave up.
    expect(layout.sidebarWidth).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
    expect(layout.zoomFloor).toBe(PANEL_ZOOM_FLOOR);
  });

  it("folds the right panel away next, and only then lets the page shrink", () => {
    const stillFits = at(VIEWER_MIN_WIDTH + SIDEBAR_MIN_WIDTH);
    expect(stillFits.sidebarCollapsed).toBe(false);
    expect(stillFits.zoomFloor).toBe(PANEL_ZOOM_FLOOR);

    const layout = at(VIEWER_MIN_WIDTH + SIDEBAR_MIN_WIDTH - 1);
    expect(layout.leftCollapsed).toBe(true);
    expect(layout.sidebarCollapsed).toBe(true);
    expect(layout.sidebarForced).toBe(true);
    expect(layout.zoomFloor).toBe(MIN_ZOOM);
    expect(layout.viewerWidth).toBe(VIEWER_MIN_WIDTH + SIDEBAR_MIN_WIDTH - 1);
  });

  it("hands every remaining pixel to the viewer once both panels are folded", () => {
    const layout = at(600);
    expect(layout.viewerWidth).toBe(600);
    expect(layout.zoomFloor).toBe(MIN_ZOOM);
  });

  it("keeps a user-minimized panel closed and gives its width to the other", () => {
    const layout = at(ROOMY, { leftHidden: true });
    expect(layout.leftCollapsed).toBe(true);
    expect(layout.leftForced).toBe(false);
    expect(layout.sidebarWidth).toBe(380);
  });

  it("re-opens a pinned panel at its minimum and lets the viewer overflow", () => {
    const width = VIEWER_MIN_WIDTH + SIDEBAR_MIN_WIDTH;
    const layout = at(width, { leftPinned: true });
    expect(layout.leftCollapsed).toBe(false);
    expect(layout.leftWidth).toBe(LEFT_MIN_WIDTH);
    expect(layout.leftForced).toBe(true);
    expect(layout.viewerWidth).toBeLessThan(VIEWER_MIN_WIDTH);
  });

  it("ignores a pin once the window is wide enough again", () => {
    const layout = at(ROOMY, { leftPinned: true });
    expect(layout.leftForced).toBe(false);
    expect(layout.leftWidth).toBe(300);
  });

  it("respects preferred widths below the minimums by lifting them", () => {
    const layout = at(ROOMY + 400, { leftPreferred: 40, sidebarPreferred: 40 });
    expect(layout.leftWidth).toBe(LEFT_MIN_WIDTH);
    expect(layout.sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("runs the same ladder with no left panel at all", () => {
    const layout = at(VIEWER_MIN_WIDTH + SIDEBAR_MIN_WIDTH - 1, {
      hasLeft: false,
    });
    expect(layout.leftWidth).toBe(0);
    expect(layout.sidebarCollapsed).toBe(true);
    expect(layout.sidebarForced).toBe(true);
  });

  it("shows preferred widths before the container has been measured", () => {
    const layout = at(0);
    expect(layout.leftWidth).toBe(300);
    expect(layout.sidebarWidth).toBe(380);
    expect(layout.leftForced).toBe(false);
  });
});

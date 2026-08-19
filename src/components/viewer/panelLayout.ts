import { MIN_ZOOM, VIEWER_MIN_WIDTH } from "./zoom";

/**
 * What gives way first as the window narrows.
 *
 * The order is deliberate — each stage is exhausted before the next begins:
 *
 *   1. the page zooms down to 100% (`zoomFloor`, applied by useViewerZoom)
 *   2. both side panels shrink toward their minimum widths
 *   3. the left panel folds into its chip
 *   4. the right panel folds into its chip
 *   5. nothing is left to give, so the page shrinks below 100% with the window
 *
 * Only stages 2–4 are decided here; stages 1 and 5 fall out of `zoomFloor`,
 * which stays at 100% for as long as a panel could still yield width.
 */

export const LEFT_MIN_WIDTH = 200;
export const SIDEBAR_MIN_WIDTH = 260;

/**
 * Hit-target width of the resize handle. The handle is an absolutely
 * positioned overlay straddling the panel's hairline border, so it takes no
 * layout width of its own — panels and viewer sit flush against each other.
 */
export const HANDLE_WIDTH = 10;

export interface PanelLayoutInput {
  /** Border-box width of the row holding both panels and the viewer. */
  containerWidth: number;
  hasLeft: boolean;
  leftPreferred: number;
  sidebarPreferred: number;
  /** The user minimized this panel — width never overrides that. */
  leftHidden: boolean;
  sidebarHidden: boolean;
  /** The user re-opened a panel the width had folded away. */
  leftPinned: boolean;
  sidebarPinned: boolean;
  viewerMinWidth?: number;
}

export interface ResolvedPanels {
  leftWidth: number;
  sidebarWidth: number;
  leftCollapsed: boolean;
  sidebarCollapsed: boolean;
  /** Collapsed by the width ladder rather than by the user. */
  leftForced: boolean;
  sidebarForced: boolean;
  viewerWidth: number;
  /** Zoom the viewer must not auto-shrink past. */
  zoomFloor: number;
}

interface PanelWidths {
  leftWidth: number;
  sidebarWidth: number;
}

/**
 * Widths for the panels that are open, or null when even their minimums do
 * not fit alongside the viewer — the caller's signal to fold one away.
 */
function fitPanels(
  panelBudget: number,
  leftOpen: boolean,
  sidebarOpen: boolean,
  leftPreferred: number,
  sidebarPreferred: number
): PanelWidths | null {
  if (!leftOpen && !sidebarOpen) return { leftWidth: 0, sidebarWidth: 0 };

  const minSum =
    (leftOpen ? LEFT_MIN_WIDTH : 0) + (sidebarOpen ? SIDEBAR_MIN_WIDTH : 0);
  const preferredSum =
    (leftOpen ? leftPreferred : 0) + (sidebarOpen ? sidebarPreferred : 0);

  if (panelBudget >= preferredSum) {
    return {
      leftWidth: leftOpen ? leftPreferred : 0,
      sidebarWidth: sidebarOpen ? sidebarPreferred : 0,
    };
  }
  if (panelBudget < minSum) return null;

  // Both panels give up the same fraction of their slack, so neither hits its
  // minimum while the other is still comfortable.
  const slack = preferredSum - minSum;
  const ratio = slack > 0 ? (preferredSum - panelBudget) / slack : 0;
  return {
    leftWidth: leftOpen
      ? leftPreferred - (leftPreferred - LEFT_MIN_WIDTH) * ratio
      : 0,
    sidebarWidth: sidebarOpen
      ? sidebarPreferred - (sidebarPreferred - SIDEBAR_MIN_WIDTH) * ratio
      : 0,
  };
}

export function resolvePanels(input: PanelLayoutInput): ResolvedPanels {
  const {
    containerWidth,
    hasLeft,
    leftHidden,
    sidebarHidden,
    leftPinned,
    sidebarPinned,
    viewerMinWidth = VIEWER_MIN_WIDTH,
  } = input;

  const leftPreferred = Math.max(LEFT_MIN_WIDTH, input.leftPreferred);
  const sidebarPreferred = Math.max(SIDEBAR_MIN_WIDTH, input.sidebarPreferred);

  let leftOpen = hasLeft && !leftHidden;
  let sidebarOpen = !sidebarHidden;

  // Before the first measurement there is nothing to ration — show what the
  // user asked for rather than flashing a collapsed layout.
  if (containerWidth <= 0) {
    return {
      leftWidth: leftOpen ? leftPreferred : 0,
      sidebarWidth: sidebarOpen ? sidebarPreferred : 0,
      leftCollapsed: !leftOpen,
      sidebarCollapsed: !sidebarOpen,
      leftForced: false,
      sidebarForced: false,
      viewerWidth: 0,
      zoomFloor: leftOpen || sidebarOpen ? 1 : MIN_ZOOM,
    };
  }

  const budget = Math.max(0, containerWidth);
  const panelBudget = budget - viewerMinWidth;

  let leftForced = false;
  let sidebarForced = false;
  let widths = fitPanels(
    panelBudget,
    leftOpen,
    sidebarOpen,
    leftPreferred,
    sidebarPreferred
  );

  if (!widths && leftOpen) {
    leftOpen = false;
    leftForced = true;
    widths = fitPanels(panelBudget, false, sidebarOpen, leftPreferred, sidebarPreferred);
  }
  if (!widths && sidebarOpen) {
    sidebarOpen = false;
    sidebarForced = true;
    widths = fitPanels(panelBudget, leftOpen, false, leftPreferred, sidebarPreferred);
  }
  widths ??= { leftWidth: 0, sidebarWidth: 0 };

  // A panel the user re-opened after the width folded it away stays open at
  // its minimum. The viewer gives up the width instead and scrolls.
  let { leftWidth, sidebarWidth } = widths;
  if (leftForced && leftPinned) {
    leftOpen = true;
    leftWidth = LEFT_MIN_WIDTH;
  }
  if (sidebarForced && sidebarPinned) {
    sidebarOpen = true;
    sidebarWidth = SIDEBAR_MIN_WIDTH;
  }

  leftWidth = Math.round(leftWidth);
  sidebarWidth = Math.round(sidebarWidth);

  return {
    leftWidth,
    sidebarWidth,
    leftCollapsed: !leftOpen,
    sidebarCollapsed: !sidebarOpen,
    leftForced,
    sidebarForced,
    viewerWidth: Math.max(0, budget - leftWidth - sidebarWidth),
    // While a panel is still open it is the next thing to give up width, so
    // the page holds at 100%. With both folded away, the page is all that's
    // left to shrink.
    zoomFloor: leftOpen || sidebarOpen ? 1 : MIN_ZOOM,
  };
}

import { useCallback, useState } from "react";
import { FIT_MARGIN, MIN_ZOOM, PAGE_WIDTH, clampZoom } from "./zoom";

/** The largest zoom that fits `viewerWidth`, never dropping below the floor. */
function zoomThatFits(preferred: number, viewerWidth: number, floor: number) {
  const widthZoom = (viewerWidth - FIT_MARGIN) / PAGE_WIDTH;
  return clampZoom(Math.min(preferred, Math.max(floor, widthZoom)));
}

/**
 * Zoom that yields to a shrinking window before the side panels do.
 *
 * It is real state rather than a derived value, because the two inputs are not
 * equal: an explicit +/−/fit is absolute and holds at any width, while a
 * *width* change re-derives the zoom from the last explicit choice, capped by
 * what now fits. `zoomFloor` — 100% while a panel could still give up width,
 * the hard minimum once both are folded away — is what keeps the page from
 * shrinking ahead of its turn (see resolvePanels).
 */
export function useViewerZoom(viewerWidth: number, zoomFloor: number) {
  const [zoom, setZoom] = useState(1);
  const [preferred, setPreferred] = useState(1);

  // Re-fit on width changes only, adjusted during render so the page never
  // paints at a zoom the new width cannot hold.
  const [measured, setMeasured] = useState({ width: 0, floor: MIN_ZOOM });
  if (
    viewerWidth > 0 &&
    (measured.width !== viewerWidth || measured.floor !== zoomFloor)
  ) {
    setMeasured({ width: viewerWidth, floor: zoomFloor });
    setZoom(zoomThatFits(preferred, viewerWidth, zoomFloor));
  }

  const chooseZoom = useCallback((next: number) => {
    const value = clampZoom(next);
    setPreferred(value);
    setZoom(value);
  }, []);

  const fitToWidth = useCallback(() => {
    if (viewerWidth <= FIT_MARGIN) return;
    chooseZoom((viewerWidth - FIT_MARGIN) / PAGE_WIDTH);
  }, [chooseZoom, viewerWidth]);

  return { zoom, chooseZoom, fitToWidth };
}

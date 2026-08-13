/** Rendered width of a page in CSS pixels at 100% zoom. */
export const PAGE_WIDTH = 700;

/** Breathing room around a page: column padding, border, and shadow. */
export const FIT_MARGIN = 40;

/** What the viewer needs to show a page at 100% without scrolling sideways. */
export const VIEWER_MIN_WIDTH = PAGE_WIDTH + FIT_MARGIN;

/** Zoom stops the −/+ buttons walk between. */
const STOPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export const MIN_ZOOM = STOPS[0];
export const MAX_ZOOM = STOPS[STOPS.length - 1];

export function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Next stop above the current zoom — works from fit-to-width's odd values. */
export function zoomIn(zoom: number) {
  return STOPS.find((stop) => stop > zoom + 0.001) ?? MAX_ZOOM;
}

export function zoomOut(zoom: number) {
  return [...STOPS].reverse().find((stop) => stop < zoom - 0.001) ?? MIN_ZOOM;
}

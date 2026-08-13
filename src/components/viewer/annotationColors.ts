/**
 * The five highlighter colors, in the order they appear in the popover.
 *
 * These are raw color literals rather than theme tokens on purpose: a
 * highlight is drawn on the page, and the page is paper — always white,
 * regardless of the app's light/dark theme (see the `bg-white` on the page
 * surface in ImagePdfViewer). A themed token would invert with the chrome and
 * stop reading as ink on paper.
 *
 * `fill` is what goes over the page — translucent, so the glyphs underneath
 * stay legible. `swatch` is the opaque version for the picker and for the dot
 * beside a note in the sidebar, where there is no page behind it to blend with.
 */
export const ANNOTATION_COLORS = [
  { key: "yellow", label: "Yellow", fill: "rgba(250, 204, 21, 0.42)", swatch: "#facc15" },
  { key: "green", label: "Green", fill: "rgba(74, 222, 128, 0.42)", swatch: "#4ade80" },
  { key: "blue", label: "Blue", fill: "rgba(96, 165, 250, 0.42)", swatch: "#60a5fa" },
  { key: "pink", label: "Pink", fill: "rgba(244, 114, 182, 0.42)", swatch: "#f472b6" },
  { key: "purple", label: "Purple", fill: "rgba(167, 139, 250, 0.42)", swatch: "#a78bfa" },
] as const;

export type AnnotationColor = (typeof ANNOTATION_COLORS)[number]["key"];

export const DEFAULT_ANNOTATION_COLOR: AnnotationColor = "yellow";

const BY_KEY = new Map(ANNOTATION_COLORS.map((color) => [color.key, color]));

/** Falls back to the default rather than throwing: an unknown color in an old
 * row should still draw something, not blank the page's markup. */
export function annotationColor(key: string) {
  return BY_KEY.get(key as AnnotationColor) ?? BY_KEY.get(DEFAULT_ANNOTATION_COLOR)!;
}

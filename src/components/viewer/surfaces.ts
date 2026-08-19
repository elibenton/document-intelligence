/**
 * The one surface still allowed to sit over the document: the pipeline
 * status chip and the pill a minimized panel leaves behind. Everything else
 * in the viewer is flat chrome — full-height columns separated by inset
 * hairline rules, with the working tools living in the header bar.
 *
 * Kept deliberately quiet: background with a hairline border and the smallest
 * shadow, so a chip reads as part of the chrome rather than a floating window.
 * The slight translucency + blur keeps text legible when a chip overlaps a
 * scrolling page without turning it back into glass. Pass it first into
 * `cn(...)` and don't re-specify rounding/background on top of it.
 */
export const FLOATING_SURFACE =
  "rounded-lg border border-border bg-background/90 backdrop-blur-sm shadow-xs";

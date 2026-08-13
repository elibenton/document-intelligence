/**
 * Every slab that floats above the viewer canvas: the side panels, the title
 * card, the back button, the toolbars, and the chips a minimized panel leaves
 * behind. One constant so they all catch the light the same way — pass it
 * first into `cn(...)` and don't re-specify rounding/background on top of it,
 * or the two will fight (whichever comes later in the class list wins) and
 * corners/surfaces stop matching across components.
 *
 * `rounded-lg` matches Button/Input's own radius, so a floating card and the
 * controls inside it read as one system rather than two competing scales.
 *
 * Actual frosted glass, not a flat gray card: translucent `bg-card/60` +
 * `backdrop-blur` so whatever sits behind a panel (canvas, or a PDF page once
 * a panel is resized over one) visibly shows through and blurs. A soft inset
 * highlight (a light catching a glass edge) keeps the glass reading even over
 * a flat backdrop. No hard border.
 *
 * Shadow is deliberately light (`shadow-sm`, not `-md`/`-lg`): the panel sits
 * directly beside the page, not over it, so a heavier shadow doesn't fall on
 * the canvas — it falls on the page's own white background and reads back as
 * a solid gray bar running down the page edge, i.e. exactly the flat "gray
 * border" this file exists to avoid, just relocated instead of removed.
 */
export const FLOATING_SURFACE =
  "rounded-lg bg-card/60 backdrop-blur-md shadow-sm ring-1 ring-inset ring-white/30 dark:ring-white/10";

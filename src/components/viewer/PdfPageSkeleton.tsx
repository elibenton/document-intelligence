/**
 * The placeholder a page wears until its canvas paints.
 *
 * Deliberately not the shared `Skeleton` primitive: that paints `bg-muted`,
 * which is a *themed* grey. The page is paper — white in both themes, like the
 * annotation colours — so a dark-mode muted tone would vanish on it. These use
 * a fixed ink-on-paper grey for the same reason `annotationColors.ts` holds
 * literals.
 *
 * Sized in container-query units against the page surface, so it scales with
 * zoom and rotation without being told either. Percentage heights do not work
 * here: the line bars sit in a content-sized flex column, so `h-[1.35%]` has no
 * definite height to resolve against and collapses to zero — which is exactly
 * what the first cut of this did. `container-type: size` gives `cqh`/`cqw` a
 * definite box in both axes.
 */

/** Line widths per paragraph, as a fraction of the text column. */
const PARAGRAPHS = [
  [1, 0.97, 0.99, 0.94, 0.62],
  [1, 0.96, 1, 0.91, 0.98, 0.55],
  [0.98, 1, 0.93, 0.72],
] as const;

export function PdfPageSkeleton({
  pageNumber,
  label,
}: {
  pageNumber: number;
  /** Announced to assistive tech; the bars themselves are decorative. */
  label: string;
}) {
  // Rotate the paragraph order per page so a run of pages doesn't read as one
  // repeating pattern, without randomness that would reflow on re-render.
  const offset = pageNumber % PARAGRAPHS.length;

  return (
    <div
      className="absolute inset-0 overflow-hidden [container-type:size]"
      aria-hidden="true"
    >
      <div className="absolute inset-x-[10cqw] top-[8cqh] bottom-[8cqh] motion-safe:animate-pulse">
        <div className="h-[2.4cqh] w-[45%] rounded-[2px] bg-black/[0.16]" />
        <div className="mt-[1.4cqh] h-[1.7cqh] w-[28%] rounded-[2px] bg-black/[0.12]" />

        {PARAGRAPHS.map((_, index) => {
          const lines = PARAGRAPHS[(index + offset) % PARAGRAPHS.length];
          return (
            <div key={index} className="mt-[3.4cqh]">
              {lines.map((width, line) => (
                <div
                  key={line}
                  className="h-[1.5cqh] rounded-[2px] bg-black/[0.105] not-first:mt-[1.3cqh]"
                  style={{ width: `${width * 100}%` }}
                />
              ))}
            </div>
          );
        })}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

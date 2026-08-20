import type { Formatter } from "./format";
// One definition of what a citation marker is, shared with the server-side
// verification pass. New answers are normalized to bare `[n]` at write time;
// the render-side tolerance below is for every answer written before that.
import { CITATION_MARKER } from "../../../convex/answerVerification";

/**
 * Turn the markers into one markdown link per cited number, anchored at
 * `#citation-n`, and — for a project on a real citation style — replace the
 * visible label with that style's own in-text form.
 *
 * The anchor is always `#citation-n`, whatever the label says, because the
 * marker's *position* is what ties a claim to a page. The stored answer keeps
 * its plain markers forever: style is applied here, at render, which is what
 * lets a project switch from numbered to Chicago and have every answer it
 * already has re-format instead of going stale.
 */
export function citationMarkdown(
  answer: string,
  formatter: Formatter | null,
  inline: boolean
) {
  return answer.replace(CITATION_MARKER, (_match, digits: string) =>
    digits
      .split(",")
      .map((digit) => {
        const number = Number(digit.trim());
        const label =
          inline && formatter ? formatter.inText(number - 1) : `[${number}]`;
        // The label can contain brackets of its own; an unescaped "]" would end
        // the markdown link early and spill the rest into the paragraph.
        const safe = label.replace(/([[\]])/g, "\\$1");
        return `[${safe}](#citation-${number})`;
      })
      .join("")
  );
}

/** The first cited source number in the answer, or null if nothing is cited. */
export function firstCitationNumber(answer: string): number | null {
  const first = new RegExp(CITATION_MARKER.source, "i").exec(answer);
  return first ? Number(first[1].split(",")[0].trim()) : null;
}

/** Every source number the answer cites, ascending, deduped. */
export function citedNumbers(answer: string): number[] {
  const numbers = new Set<number>();
  for (const match of answer.matchAll(CITATION_MARKER)) {
    for (const digit of match[1].split(",")) numbers.add(Number(digit.trim()));
  }
  return [...numbers].sort((a, b) => a - b);
}

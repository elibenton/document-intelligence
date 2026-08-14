/**
 * The issue ledger's state rules and caps, with no Convex imports.
 *
 * Split from convex/issues.ts for the reason interfazeErrors.ts is split from
 * interfaze.ts, plus one more: anything importing `_generated/server` cannot be
 * loaded by vitest in this repo at all (the Convex server runtime pulls in an
 * @opentelemetry build whose directory imports Node's ESM resolver rejects —
 * convex/metadata.test.ts has the same failure on a clean checkout). These are
 * the only branches in the feature, and they fail in the direction of staying
 * quiet, so they are exactly what must be testable.
 */

/** Distinct accounts tracked per issue. Past this the count reads "50+". */
export const OWNER_CAP = 50;

/** Occurrences kept per issue, newest first. */
export const SAMPLE_CAP = 3;

/** The shape `reopening` needs of an existing row. */
export interface ReopenCandidate {
  state: string;
  count: number;
  triage?: { atCount: number };
}

/**
 * Whether a new occurrence should pull a row back onto the open list.
 *
 * The arrow that makes this a loop rather than a one-time cleanup. Two ways
 * back:
 *
 *  - **Resolved and it happened anyway.** No build comparison: a fix that
 *    didn't take is a regression whether or not anything shipped in between,
 *    and gating on the build sha would hide exactly that case.
 *  - **Triaged and it doubled.** The report is now describing something smaller
 *    than what is happening, so it is worth writing again.
 *
 * "ignored" is the one state nothing escapes — that is what makes it useful for
 * the failures that are working as intended (someone dropped a `.exe`).
 *
 * Returns a patch fragment so the caller can spread it, empty when nothing
 * changes.
 */
export function reopening(
  existing: ReopenCandidate,
  now: number
): { state: "open"; regressedAt: number } | Record<string, never> {
  if (existing.state === "resolved") return { state: "open", regressedAt: now };
  if (
    existing.state === "triaged" &&
    existing.triage &&
    existing.count + 1 >= existing.triage.atCount * 2
  ) {
    return { state: "open", regressedAt: now };
  }
  return {};
}

import { describe, expect, it } from "vitest";
import { reopening } from "./issueState";

/**
 * The rules that make the ledger a loop rather than a list. Everything else in
 * issues.ts is a read or a patch that the deployment itself exercises; these
 * four branches decide whether a problem someone believed finished comes back,
 * and getting them wrong fails silently in the direction of staying quiet.
 */

const NOW = 1_700_000_000_000;

describe("reopening", () => {
  it("reopens a resolved issue that happened again", () => {
    expect(reopening({ state: "resolved", count: 12 }, NOW)).toEqual({
      state: "open",
      regressedAt: NOW,
    });
  });

  it("reopens a resolved issue even on the same build", () => {
    // No build comparison on purpose: a fix that did not take is a regression
    // whether or not anything shipped in between, and gating on the sha would
    // hide exactly that case.
    expect(
      reopening(
        { state: "resolved", count: 3, triage: { atCount: 3 } },
        NOW
      )
    ).toEqual({ state: "open", regressedAt: NOW });
  });

  it("reopens a triaged issue once it doubles", () => {
    // Triaged at 10, and this occurrence is the 20th.
    expect(
      reopening({ state: "triaged", count: 19, triage: { atCount: 10 } }, NOW)
    ).toEqual({ state: "open", regressedAt: NOW });
  });

  it("leaves a triaged issue alone before it doubles", () => {
    expect(
      reopening({ state: "triaged", count: 18, triage: { atCount: 10 } }, NOW)
    ).toEqual({});
  });

  it("leaves an open issue open", () => {
    expect(reopening({ state: "open", count: 99 }, NOW)).toEqual({});
  });

  it("never reopens an ignored issue", () => {
    // The point of "ignored": working-as-intended failures must stay silent no
    // matter how often they fire, or the state is worthless.
    expect(reopening({ state: "ignored", count: 10_000 }, NOW)).toEqual({});
  });

  it("does not reopen a triaged issue with no triage record", () => {
    // Defensive: the pair is written together, but a doubling test that reads
    // `atCount` off an absent record would throw inside the write path.
    expect(reopening({ state: "triaged", count: 500 }, NOW)).toEqual({});
  });
});

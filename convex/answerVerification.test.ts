import { describe, expect, it } from "vitest";
import {
  normalizeCitationMarkers,
  verifyAnswer,
} from "./answerVerification";

const CONDOR_PAGE =
  "The Condor Club at 560 Broadway is operated by S.A.W. Entertainment, Ltd. " +
  "Joseph Carouba is the current owner of the Condor Club.";
const DYNAMEX_PAGE =
  "Stormy Daniels published an op-ed arguing that exotic dancers should be " +
  "treated as freelancers, not employees, criticizing the Dynamex decision.";

describe("normalizeCitationMarkers", () => {
  it("rewrites every marker shape to canonical [n] runs", () => {
    expect(
      normalizeCitationMarkers(
        "a [5] b [Source 5] c [Source 1, 3] d [Known Facts, Source 2] e [5, 6]"
      )
    ).toBe("a [5] b [5] c [1][3] d [2] e [5][6]");
  });

  it("leaves markdown links and plain brackets alone", () => {
    const text = "see [an op-ed](https://x.com) and [Known Facts]";
    expect(normalizeCitationMarkers(text)).toBe(text);
  });
});

describe("verifyAnswer", () => {
  it("keeps a claim its cited page actually states", () => {
    const result = verifyAnswer(
      "The Condor Club is operated by S.A.W. Entertainment [1].",
      [CONDOR_PAGE]
    );
    expect(result.answer).toBe(
      "The Condor Club is operated by S.A.W. Entertainment [1]."
    );
    expect(result.totalClaims).toBe(1);
    expect(result.removedClaims).toEqual([]);
  });

  it("removes a claim whose numbers the cited page never states", () => {
    const result = verifyAnswer(
      "From 1958 to 1966 the club was owned by Gino Del Prete and Pete Mattioli [1].",
      [CONDOR_PAGE]
    );
    expect(result.answer).toBe("");
    expect(result.removedClaims).toHaveLength(1);
    expect(result.removedClaims[0]).toContain("Del Prete");
  });

  it("removes a claim cited to an unrelated page", () => {
    // The real failure this module exists for: a true-sounding fact stamped
    // with a citation to a page about something else entirely.
    const result = verifyAnswer(
      "Joseph Carouba owns the Condor Club [1].",
      [DYNAMEX_PAGE]
    );
    expect(result.removedClaims).toHaveLength(1);
  });

  it("verifies each claim against its own citations, not the pool", () => {
    const answer =
      "Joseph Carouba owns the Condor Club [1]. Dancers should be treated as freelancers [2].";
    const good = verifyAnswer(answer, [CONDOR_PAGE, DYNAMEX_PAGE]);
    expect(good.removedClaims).toEqual([]);
    const crossed = verifyAnswer(answer, [DYNAMEX_PAGE, CONDOR_PAGE]);
    expect(crossed.removedClaims).toHaveLength(2);
  });

  it("drops a bullet line entirely when its only claim fails", () => {
    const result = verifyAnswer(
      "*   **1958-1966**: Owned by Gino Del Prete [1].\n*   Operated by S.A.W. Entertainment [1].",
      [CONDOR_PAGE]
    );
    expect(result.answer).toBe("*   Operated by S.A.W. Entertainment [1].");
    expect(result.totalClaims).toBe(2);
  });

  it("accepts claims grounded in the known facts", () => {
    const result = verifyAnswer(
      "The New Century Theater is owned by Joseph Carouba [3].",
      [CONDOR_PAGE],
      "Joseph Carouba — owner of New Century Theater"
    );
    expect(result.removedClaims).toEqual([]);
  });

  it("drops a heading whose whole section was removed", () => {
    const result = verifyAnswer(
      "### Condor Club\nOperated by S.A.W. Entertainment [1].\n\n### Penthouse Club\nFounded in 1921 by unknown persons [1].",
      [CONDOR_PAGE]
    );
    expect(result.answer).toBe(
      "### Condor Club\nOperated by S.A.W. Entertainment [1]."
    );
  });

  it("leaves uncited prose and headings untouched", () => {
    const answer = "### Ownership\n\nSome unverifiable but uncited context.";
    const result = verifyAnswer(answer, [CONDOR_PAGE]);
    expect(result.answer).toBe(answer);
    expect(result.totalClaims).toBe(0);
  });

  it("removes a claim cited only to a phantom marker", () => {
    // Observed in the wild: the model inventing "[Web Search 2]", a marker
    // that names no source at all.
    const result = verifyAnswer(
      "The Crazy Horse was established in 1994 [Web Search 1].",
      [CONDOR_PAGE]
    );
    expect(result.answer).toBe("");
    expect(result.removedClaims).toEqual([
      "The Crazy Horse was established in 1994 [Web Search 1]",
    ]);
  });

  it("strips a phantom marker from a claim its real citation supports", () => {
    const result = verifyAnswer(
      "Joseph Carouba owns the Condor Club [Web Search 2] [1].",
      [CONDOR_PAGE]
    );
    expect(result.answer).toBe("Joseph Carouba owns the Condor Club [1].");
    expect(result.removedClaims).toEqual([]);
  });

  it("drops a whole table row when any of its claims fails", () => {
    const result = verifyAnswer(
      "| Club | Owner |\n| :--- | :--- |\n| Condor | S.A.W. Entertainment [1] |\n| Crazy Horse | Established 1994 [1] |",
      [CONDOR_PAGE]
    );
    expect(result.answer).toBe(
      "| Club | Owner |\n| :--- | :--- |\n| Condor | S.A.W. Entertainment [1] |"
    );
  });

  it("trims punctuation orphaned by a removed leading claim", () => {
    const result = verifyAnswer(
      "Founded in 1921 by unknown persons [1]. Operated by S.A.W. Entertainment [1].",
      [CONDOR_PAGE]
    );
    expect(result.answer).toBe("Operated by S.A.W. Entertainment [1].");
  });

  it("does not treat a markdown link label with digits as a citation", () => {
    const text = "See [Part 2/2](https://example.com) for context.";
    const result = verifyAnswer(text, [CONDOR_PAGE]);
    expect(result.answer).toBe(text);
    expect(result.totalClaims).toBe(0);
  });

  it("verifies pre-normalization marker shapes", () => {
    const result = verifyAnswer(
      "Owned from 1958 by Gino Del Prete [Source 1, 2].",
      [CONDOR_PAGE, DYNAMEX_PAGE]
    );
    expect(result.answer).toBe("");
    expect(result.removedClaims).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { normalizeTitle } from "./renameNode";

describe("normalizeTitle", () => {
  it("leaves a well-formed title alone", () => {
    expect(normalizeTitle("Roe v. SFB Management Complaint")).toBe(
      "Roe v. SFB Management Complaint"
    );
    expect(normalizeTitle("1240 Mission St Conditional Use Permit")).toBe(
      "1240 Mission St Conditional Use Permit"
    );
  });

  it("strips quotes, trailing periods, and runs of whitespace", () => {
    expect(normalizeTitle('  "Hernandez  Deposition Transcript."  ')).toBe(
      "Hernandez Deposition Transcript"
    );
  });

  it("strips a written date wherever it appears", () => {
    expect(normalizeTitle("SFMTA Board Minutes March 14, 2019")).toBe(
      "SFMTA Board Minutes"
    );
    expect(normalizeTitle("Minutes of 14 March 2019")).toBe("Minutes of");
    expect(normalizeTitle("Aug 2019 Inspection Report")).toBe(
      "Inspection Report"
    );
  });

  it("strips a numeric date", () => {
    expect(normalizeTitle("Incident Report 03/14/2019")).toBe("Incident Report");
    expect(normalizeTitle("2019-03-14 Notice of Violation")).toBe(
      "Notice of Violation"
    );
  });

  it("strips a bracketed year and tidies the empty brackets", () => {
    expect(normalizeTitle("Annual Budget (2019)")).toBe("Annual Budget");
    expect(normalizeTitle("Grand Jury Report [2018]")).toBe("Grand Jury Report");
  });

  it("strips a year hanging off a separator", () => {
    expect(normalizeTitle("Board Minutes - 2019")).toBe("Board Minutes");
    expect(normalizeTitle("Audit Findings, 2021")).toBe("Audit Findings");
  });

  it("keeps four-digit numbers that are not dates", () => {
    // A street number and an ordinary identifier are indistinguishable from a
    // stray year by shape alone, so the strip deliberately leaves them.
    expect(normalizeTitle("1240 Mission St Complaint")).toBe(
      "1240 Mission St Complaint"
    );
    expect(normalizeTitle("Fund 2000 Disbursement Schedule")).toBe(
      "Fund 2000 Disbursement Schedule"
    );
  });

  it("truncates past the hard cap", () => {
    const long = `${"Extremely Specific Matter Name ".repeat(5)}Complaint`;
    const result = normalizeTitle(long);
    expect(result.length).toBeLessThanOrEqual(71);
    expect(result.endsWith("…")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { formatEventDate } from "./eventDate";

describe("formatEventDate", () => {
  it("formats a full date", () => {
    expect(formatEventDate("2024-03-03")).toBe("Mar 3, 2024");
  });

  it("does not invent precision the value never had", () => {
    // The whole point: a value that only said "2024" must not render as a day.
    expect(formatEventDate("2024")).toBe("2024");
    expect(formatEventDate("2024-03")).toBe("Mar 2024");
  });

  it("drops a leading zero from the day but keeps the year intact", () => {
    expect(formatEventDate("2019-07-04")).toBe("Jul 4, 2019");
  });

  it("treats missing and blank values as undated", () => {
    expect(formatEventDate(undefined)).toBeNull();
    expect(formatEventDate(null)).toBeNull();
    expect(formatEventDate("")).toBeNull();
    expect(formatEventDate("   ")).toBeNull();
  });

  it("keeps a short non-ISO phrase", () => {
    expect(formatEventDate("summer 2019")).toBe("summer 2019");
  });

  it("drops a value long enough to be a misplaced sentence", () => {
    const sentence =
      "the payment was made shortly after the agreement was signed";
    expect(formatEventDate(sentence)).toBeNull();
  });

  it("falls back to the year when the month is out of range", () => {
    expect(formatEventDate("2024-13")).toBe("2024");
    expect(formatEventDate("2024-00")).toBe("2024");
  });

  it("accepts single-digit month and day", () => {
    expect(formatEventDate("2024-3-3")).toBe("Mar 3, 2024");
  });
});

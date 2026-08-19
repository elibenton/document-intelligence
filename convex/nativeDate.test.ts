import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_MS,
  exifStringToIso,
  pdfDateToIso,
  sanitizeNativeDate,
} from "./nativeDate";

const NOW = Date.UTC(2026, 7, 19); // 2026-08-19

describe("sanitizeNativeDate", () => {
  it("keeps ISO prefixes at their inherent precision", () => {
    expect(sanitizeNativeDate("2024", NOW)).toEqual({
      value: "2024",
      precision: "year",
    });
    expect(sanitizeNativeDate("2024-05", NOW)).toEqual({
      value: "2024-05",
      precision: "month",
    });
    expect(sanitizeNativeDate("2024-05-01", NOW)).toEqual({
      value: "2024-05-01",
      precision: "day",
    });
  });

  it("reduces a full timestamp to day precision", () => {
    expect(sanitizeNativeDate("2024-05-01T10:03:22Z", NOW)).toEqual({
      value: "2024-05-01",
      precision: "day",
    });
    expect(sanitizeNativeDate("2024-05-01T10:03:22+02:00", NOW)).toEqual({
      value: "2024-05-01",
      precision: "day",
    });
    expect(sanitizeNativeDate("2024-05-01 10:03:22", NOW)).toEqual({
      value: "2024-05-01",
      precision: "day",
    });
  });

  it("drops impossible dates", () => {
    expect(sanitizeNativeDate("2026-02-31", NOW)).toBeNull();
    expect(sanitizeNativeDate("2026-13", NOW)).toBeNull();
    expect(sanitizeNativeDate("2026-00-01", NOW)).toBeNull();
  });

  it("allows 48h of clock skew but no more", () => {
    const tomorrow = new Date(NOW + 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(sanitizeNativeDate(tomorrow, NOW)).toEqual({
      value: tomorrow,
      precision: "day",
    });
    const nextWeek = new Date(NOW + 7 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(sanitizeNativeDate(nextWeek, NOW)).toBeNull();
    expect(CLOCK_SKEW_MS).toBe(48 * 3600 * 1000);
  });

  it("drops garbage", () => {
    for (const junk of [
      "",
      "yesterday",
      "05/01/2024",
      "20240501",
      "2024-5-1",
      42,
      null,
      undefined,
    ]) {
      expect(sanitizeNativeDate(junk, NOW)).toBeNull();
    }
  });
});

describe("exifStringToIso", () => {
  it("converts the colon format", () => {
    expect(exifStringToIso("2019:03:14 10:22:01")).toBe("2019-03-14");
    expect(exifStringToIso("2019:03:14")).toBe("2019-03-14");
  });

  it("drops the never-set-clock blanks", () => {
    expect(exifStringToIso("    :  :  ")).toBeNull();
    expect(exifStringToIso("0000:00:00 00:00:00")).toBe("0000-00-00"); // sanitize drops it
    expect(sanitizeNativeDate(exifStringToIso("0000:00:00 00:00:00"), NOW)).toBeNull();
    expect(exifStringToIso("")).toBeNull();
    expect(exifStringToIso(undefined)).toBeNull();
  });
});

describe("pdfDateToIso", () => {
  it("parses full and truncated D: forms", () => {
    expect(pdfDateToIso("D:20190314102201+02'00'")).toBe("2019-03-14");
    expect(pdfDateToIso("D:20190314")).toBe("2019-03-14");
    expect(pdfDateToIso("D:201903")).toBe("2019-03");
    expect(pdfDateToIso("D:2019")).toBe("2019");
  });

  it("tolerates the optional-D: variant the spec allows", () => {
    expect(pdfDateToIso("20190314102201")).toBe("2019-03-14");
  });

  it("drops garbage", () => {
    expect(pdfDateToIso("D:")).toBeNull();
    expect(pdfDateToIso("March 2019")).toBeNull();
    expect(pdfDateToIso(undefined)).toBeNull();
  });
});

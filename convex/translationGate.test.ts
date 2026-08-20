import { describe, expect, it } from "vitest";
import {
  languageMatches,
  normalizeLanguageCode,
  translationDecision,
} from "./translationGate";

describe("normalizeLanguageCode", () => {
  it("lowercases and normalizes separators", () => {
    expect(normalizeLanguageCode("EN_us")).toBe("en-us");
    expect(normalizeLanguageCode(" fr ")).toBe("fr");
  });
  it("rejects garbage", () => {
    expect(normalizeLanguageCode("")).toBeUndefined();
    expect(normalizeLanguageCode("English")).toBeUndefined();
    expect(normalizeLanguageCode(undefined)).toBeUndefined();
  });
});

describe("languageMatches", () => {
  it("matches on primary subtag", () => {
    expect(languageMatches("en-us", "en")).toBe(true);
    expect(languageMatches("en", "en-gb")).toBe(true);
  });
  it("never matches unknown", () => {
    expect(languageMatches("und", "en")).toBe(false);
    expect(languageMatches(undefined, "en")).toBe(false);
  });
});

describe("translationDecision", () => {
  const target = "en";
  it("unknown when detection is missing or und", () => {
    expect(
      translationDecision({
        sourceLanguageCode: undefined,
        sourceLanguageIsMixed: undefined,
        targetLanguageCode: target,
      })
    ).toBe("unknown");
    expect(
      translationDecision({
        sourceLanguageCode: "und",
        sourceLanguageIsMixed: false,
        targetLanguageCode: target,
      })
    ).toBe("unknown");
    expect(
      translationDecision({
        sourceLanguageCode: "not a code",
        sourceLanguageIsMixed: false,
        targetLanguageCode: target,
      })
    ).toBe("unknown");
  });
  it("not_needed when the language matches, even with mixed undeclared", () => {
    expect(
      translationDecision({
        sourceLanguageCode: "en-US",
        sourceLanguageIsMixed: undefined,
        targetLanguageCode: target,
      })
    ).toBe("not_needed");
  });
  it("offers when the language differs or content is mixed", () => {
    expect(
      translationDecision({
        sourceLanguageCode: "fr",
        sourceLanguageIsMixed: false,
        targetLanguageCode: target,
      })
    ).toBe("offer");
    expect(
      translationDecision({
        sourceLanguageCode: "en",
        sourceLanguageIsMixed: true,
        targetLanguageCode: target,
      })
    ).toBe("offer");
  });
});

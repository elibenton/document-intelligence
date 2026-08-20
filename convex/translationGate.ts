/**
 * Translation decision logic — pure, so Vitest can test it directly
 * (importing anything that touches _generated/server kills the suite).
 *
 * Translation is prompt-only: no code path may start a translate call except
 * a user-initiated mutation (translations.start). This module only classifies
 * a document against the owner's default language; the classification is
 * stamped onto the document and the UI turns it into a prompt.
 */

export type TranslationDecision = "offer" | "not_needed" | "unknown";

/** Lowercased, dash-separated ISO 639 code, or undefined when unparseable. */
export function normalizeLanguageCode(
  value: string | undefined
): string | undefined {
  const code = value?.trim().toLowerCase().replaceAll("_", "-");
  if (!code || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code)) return undefined;
  return code;
}

/** Same primary subtag counts as a match: en-us reads as en. */
export function languageMatches(
  source: string | undefined,
  target: string
): boolean {
  if (!source || source === "und") return false;
  return source === target || source.split("-")[0] === target.split("-")[0];
}

export function translationDecision(args: {
  sourceLanguageCode: string | undefined;
  sourceLanguageIsMixed: boolean | undefined;
  targetLanguageCode: string;
}): TranslationDecision {
  const source = normalizeLanguageCode(args.sourceLanguageCode);
  if (!source || source === "und") return "unknown";
  if (args.sourceLanguageIsMixed === true) return "offer";
  return languageMatches(source, args.targetLanguageCode)
    ? "not_needed"
    : "offer";
}

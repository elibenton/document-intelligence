const INTERFAZE_LANGUAGE_CODES = [
  "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs",
  "ca", "ch", "co", "cs", "cy", "da", "de", "dv", "dz", "el", "en", "eo",
  "es", "et", "eu", "fa", "ff", "fi", "fj", "fo", "fr", "fy", "ga", "gd",
  "gl", "gn", "gu", "gv", "ha", "he", "hi", "hr", "ht", "hu", "hy", "id",
  "ig", "is", "it", "iu", "ja", "jv", "ka", "kg", "ki", "kj", "kk", "kl",
  "km", "kn", "ko", "kr", "ks", "ku", "kv", "kw", "ky", "la", "lb", "lg",
  "li", "ln", "lo", "lt", "lu", "lv", "mg", "mh", "mi", "mk", "ml", "mn",
  "mo", "mr", "ms", "mt", "my", "na", "nb", "nd", "ne", "ng", "nl", "nn",
  "no", "nr", "nv", "ny", "oc", "oj", "om", "or", "os", "pa", "pi", "pl",
  "ps", "pt", "qu", "rm", "rn", "ro", "ru", "rw", "sa", "sc", "sd", "se",
  "sg", "sh", "si", "sk", "sl", "sm", "sn", "so", "sq", "sr", "ss", "st",
  "su", "sv", "sw", "ta", "te", "tg", "th", "ti", "tk", "tl", "tn", "to",
  "tr", "ts", "tt", "tw", "ty", "ug", "uk", "ur", "uz", "ve", "vi", "vo",
  "wo", "xh", "yi", "yo", "zh", "zh-tw", "zu",
] as const;

const FALLBACK_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ar: "Arabic",
  he: "Hebrew",
  hi: "Hindi",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  zh: "Chinese",
  "zh-tw": "Chinese (Traditional)",
};

const RTL_CODES = new Set(["ar", "dv", "fa", "ha", "he", "ks", "ku", "ps", "ug", "ur", "yi"]);

function displayName(code: string): string {
  if (code === "zh-tw") return FALLBACK_NAMES[code];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return FALLBACK_NAMES[code] ?? code;
  }
}

export const INTERFAZE_LANGUAGES = INTERFAZE_LANGUAGE_CODES.map((code) => ({
  code,
  name: displayName(code),
})).sort((a, b) => a.name.localeCompare(b.name));

export function languageName(code: string | undefined): string {
  if (!code) return "Unknown";
  return displayName(code.toLowerCase());
}

export function languageDirection(code: string | undefined): "ltr" | "rtl" {
  return code && RTL_CODES.has(code.toLowerCase()) ? "rtl" : "ltr";
}

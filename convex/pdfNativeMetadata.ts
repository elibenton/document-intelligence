/**
 * Junk filters for a PDF's own Info-dictionary metadata.
 *
 * Pure string checks, no Convex imports, so nativeText.ts can apply them at
 * commit time and the tests can pin them without a runtime. The bar is the
 * same one the model's sanitizers in metadata.ts hold: a value that is really
 * an authoring tool's residue — "Microsoft Word - draft3.docx", a login name,
 * "Untitled" — is worse than no value, because it displaces the field the
 * reader would otherwise get from analysis.
 */

import {
  pdfDateToIso,
  sanitizeNativeDate,
  type NativeDate,
} from "./nativeDate";

/** Authoring-tool residue that shows up in Info.Title. */
const TITLE_JUNK = [
  /^untitled/i,
  /^(microsoft\s+)?(word|powerpoint|excel|publisher)\b/i,
  /^(document|presentation|book|slide\s*\d*)$/i,
  /^print$/i,
  /^(scan|scanned(\s+document)?)(\s*\d*)?$/i,
  // A filename posing as a title, from any common authoring format.
  /\.(pdf|docx?|rtf|txt|indd|qxd|pptx?|xlsx?|odt|pages|tex|md)$/i,
];

const AUTHOR_JUNK = [
  /^(user|admin|administrator|owner|unknown|author|default|windows|registered)$/i,
  // Authoring software credited as the author.
  /^(adobe|acrobat|microsoft|word|libreoffice|openoffice|pdf)\b/i,
];

function collapsed(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

/**
 * The document's own stated title, or nothing. `fileName` is the upload
 * filename — a title that merely restates it carries no information the
 * library doesn't already show.
 */
export function cleanPdfTitle(
  raw: unknown,
  fileName: string
): string | undefined {
  const title = collapsed(raw);
  if (title.length < 3 || title.length > 160) return undefined;
  if (TITLE_JUNK.some((pattern) => pattern.test(title))) return undefined;
  const name = collapsed(fileName).toLowerCase();
  const stem = name.replace(/\.[a-z0-9]+$/i, "");
  const lower = title.toLowerCase();
  if (lower === name || lower === stem) return undefined;
  return title;
}

/** The document's own stated creation date, or nothing. */
export function cleanPdfDate(raw: unknown, now: number): NativeDate | null {
  return sanitizeNativeDate(pdfDateToIso(raw), now);
}

/** The document's own credited author, or nothing. */
export function cleanPdfAuthor(raw: unknown): string | undefined {
  const author = collapsed(raw);
  if (author.length < 2 || author.length > 120) return undefined;
  if (AUTHOR_JUNK.some((pattern) => pattern.test(author))) return undefined;
  return author;
}

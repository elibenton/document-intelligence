/**
 * Turning one failure into a group key.
 *
 * Every failure the app records arrives as prose written for a human: a
 * provider's error string, a preflight rejection, a caught exception's message.
 * Two of them describing the same defect differ only in the parts that name the
 * user's data — the document title, the id, the signed storage URL, the byte
 * count. Strip exactly those and identical defects collapse onto one row.
 *
 * `scrub` is therefore load-bearing twice over, and that is the point of
 * writing it once: it is what makes grouping stable, *and* it is the only thing
 * standing between a user's document title and the issue ledger. A ledger the
 * owner reads (and hands to a triage agent) must not become a second, quieter
 * copy of what people uploaded — so the redaction is not a policy applied at
 * read time, it happens before the row is written and there is no unscrubbed
 * path.
 *
 * SDK-free and not `"use node"`: ordinary mutations import this.
 */

import { fnv1a } from "./hash";

/** How much normalized text feeds the fingerprint (and shows as the title). */
const TITLE_CHARS = 200;
/** How much scrubbed prose each stored sample keeps. */
export const SAMPLE_CHARS = 300;

/**
 * Remove everything that names a particular user, file, or request, preserving
 * case and word order so the result still reads as a sentence.
 *
 * Order matters: URLs go first so their query strings are gone before the id
 * and number rules could pick them apart, and numbers go last so they cannot
 * eat the digits inside an id or a UUID.
 */
export function scrub(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<id>"
    )
    // Convex ids are 32 lowercase alphanumerics. The same shape covers the
    // storage ids and Better Auth user ids that turn up in error prose.
    .replace(/\b[a-z0-9]{32}\b/g, "<id>")
    // Anything the caller quoted is a name they were handed — a file, a
    // document, a title. Straight and curly quotes both appear in our strings.
    .replace(/"[^"]*"/g, "<name>")
    .replace(/“[^”]*”/g, "<name>")
    // No rule for *unquoted* filenames, deliberately. A pattern loose enough to
    // catch "Q3 budget final.docx" has to allow spaces, and then it eats the
    // sentence in front of it — "could not read Q3 budget final.docx" scrubs to
    // "<file>", which is both unreadable and a worse group key. It would also be
    // guarding against nothing: every message this app writes either quotes the
    // name (caught above) or never mentions it — preflight builds its rejections
    // from size and page count alone (src/lib/pdfPreflight.ts) — and what we
    // hand a provider is a signed URL, not a filename.
    .replace(/\b\d[\d,._]*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** A scrubbed sample of the original prose, for the report to quote. */
export function sampleText(message: string): string {
  return scrub(message).slice(0, SAMPLE_CHARS);
}

/**
 * The grouping form: scrubbed, lowercased, and clipped. Also what the ledger
 * stores as the row's title, so the thing being counted and the thing being
 * read are the same string and cannot disagree.
 */
export function normalizeMessage(message: string): string {
  return scrub(message).toLowerCase().slice(0, TITLE_CHARS);
}

/**
 * The identity of a group.
 *
 * `errorCode` is included deliberately even though it is usually implied by the
 * message: it is the one field written from a closed vocabulary rather than by
 * a provider, so two messages that drift apart in wording stay separable by the
 * code, and a message that stays identical while the code changes splits — which
 * is the case where something real changed underneath.
 */
export function issueFingerprint(input: {
  surface: string;
  stage: string;
  errorCode?: string;
  fileKind?: string;
  normalized: string;
}): string {
  return fnv1a(
    [
      input.surface,
      input.stage,
      input.errorCode ?? "",
      input.fileKind ?? "",
      input.normalized,
    ].join("|")
  );
}

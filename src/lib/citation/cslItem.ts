/**
 * A document row, as CSL-JSON.
 *
 * This is the join between what Analyze read off the page and what a citation
 * processor needs. Three of the facts a reference wants are *not* in
 * `documents.citation`, deliberately — the app already knows them, and asking
 * the model for a second copy would cost tokens for a worse answer:
 *
 *   title     `displayName`, the name the library shows
 *   issued    `documentDate` + `documentDatePrecision`
 *   URL       `sourceUrl` for a web clip, else a URL printed in the document
 *   accessed  `uploadedAt`, and only for a web clip — it is when *we* fetched
 *             it, which is what "accessed" means and is meaningless for a PDF
 *             someone handed over
 *
 * Pure and dependency-free so it can be unit-tested without loading a 400KB
 * style sheet.
 */

/** The fields of a `documents` row a citation is built from. */
export interface CitationSource {
  _id: string;
  name: string;
  displayName?: string;
  /** Analyze's specific type ("preliminary approval order"), used as CSL
   *  `genre` when the document has no bibliographic type of its own. */
  primaryKind?: string;
  documentDate?: string;
  documentDatePrecision?: string;
  sourceUrl?: string;
  uploadedAt?: number;
  citation?: {
    type?: string;
    contributors?: Array<{
      role: string;
      family?: string;
      given?: string;
      literal?: string;
    }>;
    containerTitle?: string;
    publisher?: string;
    publisherPlace?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    edition?: string;
    number?: string;
    authority?: string;
    jurisdiction?: string;
    genre?: string;
    doi?: string;
    isbn?: string;
    url?: string;
  };
}

interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}

export interface CslItem {
  id: string;
  type: string;
  title: string;
  [key: string]: unknown;
}

/**
 * An ISO prefix as CSL date-parts, truncated to the precision it actually has.
 * "2013-01" becomes [[2013, 1]] rather than [[2013, 1, 1]], so a style that
 * prints a month prints a month and one that prints a full date declines —
 * which is the same bargain `sanitizeDocumentDate` enforces on the way in.
 */
function issuedFrom(date: string | undefined): { "date-parts": number[][] } | undefined {
  if (!date) return undefined;
  const parts = date
    .split("-")
    .map((piece) => Number(piece))
    .filter((piece) => Number.isFinite(piece) && piece > 0);
  if (parts.length === 0) return undefined;
  return { "date-parts": [parts] };
}

function timestampParts(ms: number | undefined): { "date-parts": number[][] } | undefined {
  if (!ms || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return { "date-parts": [[d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]] };
}

function nameOf(person: {
  family?: string;
  given?: string;
  literal?: string;
}): CslName | null {
  if (person.literal) return { literal: person.literal };
  if (person.family || person.given) {
    return {
      ...(person.family ? { family: person.family } : {}),
      ...(person.given ? { given: person.given } : {}),
    };
  }
  return null;
}

/** Drop keys with no value, so citeproc never sees an empty string it might print. */
function compact(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(item).filter(
      ([, value]) =>
        value !== undefined &&
        value !== "" &&
        !(Array.isArray(value) && value.length === 0)
    )
  );
}

export function toCslItem(source: CitationSource): CslItem {
  const c = source.citation ?? {};

  const byRole = (role: string): CslName[] =>
    (c.contributors ?? [])
      .filter((person) => person.role === role)
      .map(nameOf)
      .filter((n): n is CslName => n !== null);

  const authors = byRole("author");
  const isWebClip = Boolean(source.sourceUrl);

  // Resolved first: `genre` below depends on which type we settled on.
  //
  // The generic bucket is emitted as CSL `report`, not `document`. Chicago's
  // bibliography has no layout for `document` (nor `manuscript`) and renders it
  // as *nothing* — measured across every combination of author, genre and
  // date — so a Chicago reference list would silently omit most of a corpus
  // whose documents rarely have a clean bibliographic type. `report` is the
  // closest CSL type every style lays out, and `genre` below carries the
  // specific label ("preliminary approval order") so nothing is lost by it.
  const type = c.type && c.type !== "document"
    ? c.type
    : isWebClip
      ? "webpage"
      : "report";

  const item = {
    id: source._id,
    type,
    title: source.displayName?.trim() || source.name,
    author: authors,
    editor: byRole("editor"),
    translator: byRole("translator"),
    "container-title": c.containerTitle,
    publisher: c.publisher,
    "publisher-place": c.publisherPlace,
    volume: c.volume,
    issue: c.issue,
    page: c.pages,
    edition: c.edition,
    number: c.number,
    authority: c.authority,
    jurisdiction: c.jurisdiction,
    // A CSL `document` with no genre renders as an *empty* bibliography entry
    // in Chicago — the style has no layout for it — so a reference list would
    // silently drop most of this corpus. `primaryKind` is the same kind of
    // fact CSL means by genre (a descriptive label for what the item is), and
    // Analyze derived it from the document's own quoted evidence.
    genre: c.genre || (c.type && c.type !== "document" ? undefined : source.primaryKind),
    DOI: c.doi,
    ISBN: c.isbn,
    URL: source.sourceUrl || c.url,
    issued: issuedFrom(source.documentDate),
    // Only for something we fetched ourselves — see the note above.
    accessed: isWebClip ? timestampParts(source.uploadedAt) : undefined,
  };

  return compact(item) as unknown as CslItem;
}

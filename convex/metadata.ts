import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { OTHER_CATEGORY } from "./analyzePrompt";
import { applyDisplayName, normalizeTitle } from "./rename";
import { authedMutation } from "./authz";
import { requireDocument } from "./ownership";

// ---------------------------------------------------------------------------
// Metadata pass — default-runtime half.
//
// The Interfaze call (runMetadataPass) lives in metadataNode.ts under
// "use node" because the Interfaze SDK needs the Node runtime; this file keeps
// the mutations that persist and edit its output.
// ---------------------------------------------------------------------------

export const saveMetadataResult = internalMutation({
  args: {
    documentId: v.id("documents"),
    raw: v.string(),
    // The merged pipeline call carries the graph on the same response and
    // ingests it itself; scheduling the standalone pass too would extract
    // every document twice.
    skipRelationships: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    let parsed: {
      title?: string;
      summary?: string;
      date?: string;
      author?: string;
      language?: string;
      source_language_code?: string;
      is_multilingual?: boolean;
      primary_kind?: string;
      primary_category?: string;
      display_title?: string;
      document_date?: { value?: string; precision?: string; evidence?: string };
      place?: { value?: string; evidence?: string };
      tags?: string[];
      table_of_contents?: Array<{ title?: string; level?: number; page?: number }>;
      additional?: Array<{ key?: string; value?: string }>;
      citation?: CitationInput;
    };
    try {
      parsed = JSON.parse(args.raw);
    } catch {
      return;
    }

    const document = await ctx.db.get(args.documentId);
    if (!document) return;

    const kindName = (parsed.primary_kind ?? "").trim().toLowerCase();

    const toc = sanitizeTableOfContents(
      parsed.table_of_contents,
      document.pageCount
    );


    const documentDate = sanitizeDocumentDate(parsed.document_date, Date.now());
    const documentPlace = sanitizeDocumentPlace(parsed.place);
    // An off-enum category is the model free-styling (or a category since
    // deleted); "other" is the honest bucket for it, and the library shows no
    // primary pill for it rather than coloring a word Analyze made up.
    const category = (parsed.primary_category ?? "").trim().toLowerCase();
    const projectId = document.projectId;
    const validCategories = new Set(
      projectId
        ? (
            await ctx.db
              .query("documentCategories")
              .withIndex("by_project", (q) => q.eq("projectId", projectId))
              .collect()
          ).map((c) => c.key)
        : []
    );
    const primaryCategory = validCategories.has(category) ? category : OTHER_CATEGORY;

    // Register the kind against this document's project (never overwrite an
    // existing one). A document outside any project has nowhere to put it.
    if (kindName && projectId) {
      await ctx.runMutation(internal.kinds.upsert, {
        projectId,
        name: kindName,
        source: "ai",
      });
    }

    // Human-set kind wins over the AI guess; tags merge
    const tagSet = new Set(document.tags ?? []);
    for (const t of parsed.tags ?? []) {
      if (typeof t === "string" && t.trim()) tagSet.add(t.trim().toLowerCase());
    }

    await ctx.db.patch(args.documentId, {
      ...(document.kindSource === "human" || !kindName
        ? {}
        : { kinds: [kindName], primaryKind: kindName, kindSource: "ai" }),
      tags: [...tagSet],
      // An empty outline is written as [] rather than skipped: it records
      // "Analyze ran and found no sections", and the Contents tab treats it
      // the same as absent by falling back to SectionHeader blocks.
      tableOfContents: toc,
      primaryCategory,
      // Cleared rather than left stale when a re-run can no longer date the
      // document: the previous run's answer is not evidence for this one.
      documentDate: documentDate?.documentDate,
      documentDatePrecision: documentDate?.documentDatePrecision,
      documentPlace: documentPlace?.documentPlace,
      documentPlaceEvidence: documentPlace?.documentPlaceEvidence,
      // Cleared rather than left stale on a re-run, the same as the date and
      // place above: the previous run's bibliography is not evidence for this
      // one, and a citation that survives the analysis it came from is exactly
      // the kind of stale claim a reader would reprint.
      citation: sanitizeCitation(parsed.citation),
      metadata: JSON.stringify({
        title: parsed.title,
        summary: parsed.summary,
        date: parsed.date,
        author: parsed.author,
        language: parsed.language,
        additional: parsed.additional ?? [],
      }),
      ...(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(
        (parsed.source_language_code ?? "").trim().toLowerCase().replaceAll("_", "-")
      )
        ? {
            sourceLanguageCode: parsed.source_language_code!
              .trim()
              .toLowerCase()
              .replaceAll("_", "-"),
          }
        : {}),
      ...(typeof parsed.is_multilingual === "boolean"
        ? { sourceLanguageIsMixed: parsed.is_multilingual }
        : {}),
    });

    // The title comes back on this same response now (TITLE_RULE in
    // analyzePrompt.ts), written after primary_kind and before any date field.
    // It used to be a second Interfaze call over a re-fetched excerpt, which
    // re-sent ~4,000 characters Analyze already had in full.
    //
    // normalizeTitle still runs: the prompt forbids dates, but a date can be
    // read straight out of the document text, and one leaked date in a column
    // of dateless titles is the ragged edge the rule exists to prevent.
    const displayTitle = normalizeTitle(parsed.display_title ?? "");
    if (displayTitle) {
      await applyDisplayName(ctx, args.documentId, displayTitle);
    }

    // ...and understood well enough to read for people and organizations.
    //
    // This used to start the suggested-extraction pass, which asked for
    // whatever Analyze thought was worth pulling out and typed each entity by
    // the JSON key that produced it — which is how entities called "dates" and
    // "parties" got into the table. One pass now finds the entities and their
    // relationships together; nothing else is extracted.
    //
    // Scheduled from here rather than from the pipeline so a standalone
    // Analyze retry gets the same treatment.
    if (!args.skipRelationships) {
      await ctx.scheduler.runAfter(0, internal.processing.runRelationshipsInternal, {
        documentId: args.documentId,
      });
    }
  },
});

/**
 * The document's own creation date, or nothing.
 *
 * The prompt asks the model to decline rather than guess, and this is the
 * other half of that bargain: anything that isn't a well-formed ISO prefix
 * agreeing with its own stated precision is dropped, so a malformed or
 * over-confident answer degrades to "Unknown" instead of misfiling the
 * document. A date in the future is dropped for the same reason — no document
 * states a creation date it hasn't reached yet, so it's a parse error or a
 * hallucination either way.
 */
export function sanitizeDocumentDate(
  raw: { value?: string; precision?: string; evidence?: string } | undefined,
  now: number
): { documentDate: string; documentDatePrecision: string } | null {
  if (!raw) return null;
  const value = (raw.value ?? "").trim();
  const precision = (raw.precision ?? "").trim().toLowerCase();
  if (!value || precision === "unknown") return null;

  // The shape of the value has to be the precision it claims — a "day"
  // precision on "2026" is the model contradicting itself, and picking a
  // winner between the two fields would be inventing information.
  const shape =
    /^\d{4}$/.test(value)
      ? "year"
      : /^\d{4}-\d{2}$/.test(value)
        ? "month"
        : /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? "day"
          : null;
  if (shape === null || shape !== precision) return null;

  // Parsed as UTC so a local timezone can't shift a bare date across a day
  // boundary. Catches impossible dates (2026-02-31) as well as unparseable
  // ones: Date.parse normalizes rather than rejecting, so compare it back.
  const whole =
    shape === "year" ? `${value}-01-01` : shape === "month" ? `${value}-01` : value;
  const parsed = new Date(`${whole}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (shape === "day" && parsed.toISOString().slice(0, 10) !== value) return null;
  if (parsed.getTime() > now) return null;

  return { documentDate: value, documentDatePrecision: shape };
}

/** Words Analyze reaches for instead of leaving the place empty. */
const NOT_A_PLACE = /^(unknown|unspecified|none|n\/?a|not stated|undisclosed)$/i;

/** A place name, not a sentence — anything longer is the model narrating. */
const MAX_PLACE_LENGTH = 120;

/**
 * The place the document situates itself in, or nothing.
 *
 * The counterpart to sanitizeDocumentDate, and the same bargain: the prompt
 * asks the model to decline rather than guess, and this drops the answers that
 * are a decline wearing a value's clothes. There is no shape to validate the
 * way an ISO prefix can be validated, so the checks are what is left — a
 * refusal word, or a run of prose where a place name belongs.
 *
 * The evidence quote is kept only when there is a place for it to support.
 */
export function sanitizeDocumentPlace(
  raw: { value?: string; evidence?: string } | undefined
): { documentPlace: string; documentPlaceEvidence?: string } | null {
  if (!raw) return null;
  const value = (raw.value ?? "").trim().replace(/\s+/g, " ");
  if (!value || NOT_A_PLACE.test(value) || value.length > MAX_PLACE_LENGTH) {
    return null;
  }
  const evidence = (raw.evidence ?? "").trim();
  return {
    documentPlace: value,
    documentPlaceEvidence: evidence ? evidence.slice(0, 500) : undefined,
  };
}

/**
 * Bibliographic values are labels, not prose. The same guard as
 * MAX_PLACE_LENGTH and for the same reason: a run of prose in a field that
 * holds a publisher's name is the model narrating why it cannot answer.
 * Sized against the longest real ones — "Proceedings of the National Academy
 * of Sciences of the United States of America" is 79, "United States District
 * Court for the Northern District of California" 68 — with room to spare.
 */
const MAX_CITATION_FIELD = 160;
/** More contributors than this is the model listing everyone the document
 *  mentions rather than everyone credited with producing it. */
const MAX_CONTRIBUTORS = 24;

/** The CSL types the prompt offers. An off-enum answer is the model inventing
 *  a vocabulary, and "document" is the honest bucket for it. */
const CITATION_TYPES = new Set([
  "article-journal",
  "article-newspaper",
  "book",
  "chapter",
  "report",
  "legal_case",
  "legislation",
  "patent",
  "webpage",
  "manuscript",
  "speech",
  "dataset",
  "personal_communication",
  "document",
]);

const CONTRIBUTOR_ROLES = new Set(["author", "editor", "translator"]);

/** Values a model returns when it means "empty" but felt obliged to answer. */
const NOT_A_VALUE =
  /^(unknown|unspecified|none|n\/?a|not stated|not provided|undisclosed|null|-+)$/i;

function citationField(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value || NOT_A_VALUE.test(value) || value.length > MAX_CITATION_FIELD) {
    return undefined;
  }
  return value;
}

export interface CitationInput {
  type?: string;
  contributors?: Array<{
    role?: string;
    family?: string;
    given?: string;
    literal?: string;
  }>;
  container_title?: string;
  publisher?: string;
  publisher_place?: string;
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
}

/**
 * The bibliographic facts worth keeping, or nothing.
 *
 * The counterpart to CITATION_RULE, and the strictest of these sanitizers on
 * purpose: a citation is a claim a reader will check and may reprint, so a
 * field that is a refusal word wearing a value's clothes has to be dropped
 * rather than formatted into a reference.
 *
 * Returns undefined when nothing survives — including when only `type` does.
 * A bare `type: "document"` is the model answering a required field, not a fact
 * about the document, and storing it would make every analyzed document look as
 * though it had citation data.
 */
export function sanitizeCitation(
  raw: CitationInput | undefined
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const contributors = (Array.isArray(raw.contributors) ? raw.contributors : [])
    .slice(0, MAX_CONTRIBUTORS)
    .map((person) => {
      const role = (person?.role ?? "").trim().toLowerCase();
      return {
        role: CONTRIBUTOR_ROLES.has(role) ? role : "author",
        family: citationField(person?.family),
        given: citationField(person?.given),
        literal: citationField(person?.literal),
      };
    })
    // A contributor with no name at all is an empty slot the model filled to
    // satisfy the array, not a person.
    .filter((person) => person.family || person.given || person.literal);

  const type = (raw.type ?? "").trim().toLowerCase();
  const citation = {
    type: CITATION_TYPES.has(type) ? type : undefined,
    contributors: contributors.length > 0 ? contributors : undefined,
    containerTitle: citationField(raw.container_title),
    publisher: citationField(raw.publisher),
    publisherPlace: citationField(raw.publisher_place),
    volume: citationField(raw.volume),
    issue: citationField(raw.issue),
    pages: citationField(raw.pages),
    edition: citationField(raw.edition),
    number: citationField(raw.number),
    authority: citationField(raw.authority),
    jurisdiction: citationField(raw.jurisdiction),
    genre: citationField(raw.genre),
    doi: citationField(raw.doi),
    isbn: citationField(raw.isbn),
    url: citationField(raw.url),
  };

  // Everything but `type` — see the doc comment on why type alone is not data.
  const hasFacts = Object.entries(citation).some(
    ([field, value]) => field !== "type" && value !== undefined
  );
  if (!hasFacts) return undefined;

  return Object.fromEntries(
    Object.entries(citation).filter(([, value]) => value !== undefined)
  );
}

/** Hard ceiling on outline entries — a plausible TOC, not a re-typed document. */
const MAX_TOC_ENTRIES = 500;
const MAX_TOC_LEVEL = 4;

/**
 * Make a model-produced outline safe to render.
 *
 * The Contents tab indents by `level` and navigates by `page`, so both have to
 * be trustworthy: a level of 0 or 9 breaks the indent ladder, and a page past
 * the end of the document is a dead link. Levels are also normalized so the
 * list starts at 1 and never jumps by more than one, which is what makes the
 * flat array read back as a tree.
 */
export function sanitizeTableOfContents(
  entries: Array<{ title?: string; level?: number; page?: number }> | undefined,
  pageCount: number | undefined
): Array<{ title: string; level: number; page: number }> {
  if (!Array.isArray(entries)) return [];
  const lastPage = pageCount && pageCount > 0 ? pageCount : undefined;
  const cleaned: Array<{ title: string; level: number; page: number }> = [];
  let previousLevel = 0;

  for (const entry of entries) {
    if (cleaned.length >= MAX_TOC_ENTRIES) break;
    const title = typeof entry?.title === "string" ? entry.title.trim() : "";
    if (!title) continue;

    const rawLevel = Math.trunc(Number(entry?.level));
    const level = Math.min(
      // No jumping straight from a level 1 to a level 3: clamp each entry to
      // one deeper than the one before it, so indentation stays a ladder.
      Number.isFinite(rawLevel) ? Math.max(1, rawLevel) : previousLevel || 1,
      previousLevel + 1,
      MAX_TOC_LEVEL
    );

    const rawPage = Math.trunc(Number(entry?.page));
    const page = Number.isFinite(rawPage)
      ? Math.min(Math.max(1, rawPage), lastPage ?? Math.max(1, rawPage))
      : 1;

    cleaned.push({ title: title.slice(0, 300), level, page });
    previousLevel = level;
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Human edits to kind / tags / metadata
// ---------------------------------------------------------------------------

export const updateDocumentMeta = authedMutation({
  args: {
    documentId: v.id("documents"),
    primaryKind: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    // The Info tab still edits a single kind; write the array alongside it so
    // the two never drift (documents.updateIdentity writes both as well).
    const kind = args.primaryKind?.trim().toLowerCase();
    await ctx.db.patch(args.documentId, {
      ...(args.primaryKind !== undefined
        ? {
            kinds: kind ? [kind] : [],
            primaryKind: kind || undefined,
            kindSource: "human",
          }
        : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    });
  },
});

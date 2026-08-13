import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { OTHER_CATEGORY } from "./analyzePrompt";
import { applyDisplayName, normalizeTitle } from "./rename";

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
      tags?: string[];
      suggested_roles?: Array<{ role?: string; question?: string; entity_type?: string }>;
      suggested_extractions?: Array<{
        label?: string;
        prompt?: string;
        rationale?: string;
      }>;
      table_of_contents?: Array<{ title?: string; level?: number; page?: number }>;
      additional?: Array<{ key?: string; value?: string }>;
    };
    try {
      parsed = JSON.parse(args.raw);
    } catch {
      return;
    }

    const document = await ctx.db.get(args.documentId);
    if (!document) return;

    const kindName = (parsed.primary_kind ?? "").trim().toLowerCase();
    const roles = (parsed.suggested_roles ?? [])
      .filter((r) => r.role?.trim() && r.question?.trim())
      .map((r) => ({
        role: r.role!.trim().toLowerCase(),
        question: r.question!.trim(),
        entityType: ["person", "organization", "place", "other"].includes(r.entity_type ?? "")
          ? r.entity_type!
          : "person",
      }));

    const toc = sanitizeTableOfContents(
      parsed.table_of_contents,
      document.pageCount
    );

    const suggestedExtractions = (parsed.suggested_extractions ?? [])
      .map((suggestion) => ({
        label: (suggestion.label ?? "").trim(),
        prompt: (suggestion.prompt ?? "").trim(),
        rationale: (suggestion.rationale ?? "").trim(),
      }))
      .filter((suggestion) => suggestion.label && suggestion.prompt)
      .slice(0, 8);

    const documentDate = sanitizeDocumentDate(parsed.document_date, Date.now());
    // An off-enum category is the model free-styling (or a category since
    // deleted); "other" is the honest bucket for it, and the library shows no
    // primary pill for it rather than coloring a word Analyze made up.
    const category = (parsed.primary_category ?? "").trim().toLowerCase();
    const validCategories = new Set(
      (await ctx.db.query("documentCategories").collect()).map((c) => c.key)
    );
    const primaryCategory = validCategories.has(category) ? category : OTHER_CATEGORY;

    // Register the kind (never overwrite an existing template)
    if (kindName) {
      await ctx.runMutation(internal.kinds.upsert, {
        name: kindName,
        source: "ai",
        templateRoles: roles,
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
      suggestedRoles: roles,
      // An empty outline is written as [] rather than skipped: it records
      // "Analyze ran and found no sections", and the Contents tab treats it
      // the same as absent by falling back to SectionHeader blocks.
      tableOfContents: toc,
      primaryCategory,
      // Cleared rather than left stale when a re-run can no longer date the
      // document: the previous run's answer is not evidence for this one.
      documentDate: documentDate?.documentDate,
      documentDatePrecision: documentDate?.documentDatePrecision,
      suggestedExtractions,
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

    // ...and understood well enough to extract from. This is the moment the
    // suggestions exist, so it's where the initial extraction starts; there is
    // no review step in between any more. Scheduled from here rather than from
    // the pipeline so a standalone Analyze retry gets the same treatment.
    await ctx.scheduler.runAfter(0, internal.processing.runInitialExtraction, {
      documentId: args.documentId,
    });
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

export const updateDocumentMeta = mutation({
  args: {
    documentId: v.id("documents"),
    primaryKind: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) return;
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

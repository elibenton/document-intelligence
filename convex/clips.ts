import { internalMutation, internalQuery } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { sanitizeNativeDate } from "./nativeDate";
import { recordOverride } from "./apiLogs";
import { cleanPdfAuthor } from "./pdfNativeMetadata";
import { languageForProject } from "./settings";
import {
  normalizeLanguageCode,
  translationDecision,
} from "./translationGate";

// ---------------------------------------------------------------------------
// Web clip ingestion. The extension already parsed the page (Readability →
// markdown), so clips skip the Interfaze parse step: pages/blocks are inserted
// directly and only the metadata pass is scheduled. Entity extraction then
// waits for template confirmation in the review UI, same as PDFs.
// ---------------------------------------------------------------------------

// Keep each page's text well under the 1MB Convex value limit.
const PAGE_CHAR_LIMIT = 100_000;

function chunkIntoPages(markdown: string): string[] {
  const paragraphs = markdown.split(/\n{2,}/);
  const pages: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    // A single paragraph longer than the limit gets hard-split.
    const pieces =
      para.length > PAGE_CHAR_LIMIT
        ? (para.match(new RegExp(`[\\s\\S]{1,${PAGE_CHAR_LIMIT}}`, "g")) ?? [])
        : [para];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > PAGE_CHAR_LIMIT) {
        pages.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.trim()) pages.push(current);
  return pages.length > 0 ? pages : [markdown.slice(0, PAGE_CHAR_LIMIT)];
}

/**
 * Is this URL already clipped in any of the owner's projects? Powers the
 * popup's re-clip warning (GET /clip/lookup) and the pre-storage duplicate
 * refusal in POST /clip — both authenticated by the same bearer token, so
 * this resolves it itself, like clipperTokens.projectsFor.
 */
export const lookupClipped = internalQuery({
  args: { token: v.string(), url: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      documentId: v.id("documents"),
      projectId: v.id("projects"),
      projectName: v.string(),
      clippedAt: v.number(),
      // The document's current metadata, so the popup can show (and edit)
      // what's already filled instead of an empty preview.
      meta: v.object({
        title: v.optional(v.string()),
        author: v.optional(v.string()),
        publishedAt: v.optional(v.string()),
        siteName: v.optional(v.string()),
        description: v.optional(v.string()),
      }),
    })
  ),
  handler: async (ctx, args) => {
    if (!args.token) return null;
    const row = await ctx.db
      .query("clipperTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!row) return null;
    const owned = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", row.ownerId))
      .collect();
    for (const project of owned) {
      const existing = await ctx.db
        .query("documents")
        .withIndex("by_project_sourceUrl", (q) =>
          q.eq("projectId", project._id).eq("sourceUrl", args.url)
        )
        .first();
      if (existing) {
        let blob: Record<string, unknown> = {};
        try {
          blob = existing.metadata ? JSON.parse(existing.metadata) : {};
        } catch {
          /* unparseable blob — fall back to the live columns alone */
        }
        const str = (value: unknown): string | undefined =>
          typeof value === "string" && value.trim() ? value : undefined;
        const site = (Array.isArray(blob.additional) ? blob.additional : [])
          .map((entry) => entry as Record<string, unknown> | null)
          .find((entry) => entry?.key === "site")?.value;
        return {
          documentId: existing._id,
          projectId: project._id,
          projectName: project.name,
          clippedAt: existing.uploadedAt,
          meta: {
            title: existing.displayName ?? existing.name,
            author: existing.author ?? str(blob.author),
            publishedAt: existing.createdDate ?? str(blob.date),
            siteName: str(site),
            description: str(blob.summary),
          },
        };
      }
    }
    return null;
  },
});

export const createFromClip = internalMutation({
  args: {
    // Resolved from the caller's clipper token by http.ts /clip. Both are
    // re-verified against the live project row below: a token can outlive the
    // project it points at, and a stale one must not file into someone else's.
    projectId: v.id("projects"),
    ownerId: v.string(),
    title: v.string(),
    url: v.string(),
    storageId: v.id("_storage"),
    textStorageId: v.id("_storage"),
    articleMarkdown: v.string(),
    tags: v.array(v.string()),
    notes: v.optional(v.string()),
    byline: v.optional(v.string()),
    siteName: v.optional(v.string()),
    description: v.optional(v.string()),
    publishedAt: v.optional(v.string()),
    excerpt: v.optional(v.string()),
    lang: v.optional(v.string()),
    ogImage: v.optional(v.string()),
    // The user saw the popup's re-clip warning and chose "Clip again".
    force: v.optional(v.boolean()),
  },
  returns: v.id("documents"),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.ownerId !== args.ownerId) {
      throw new ConvexError("Clipper token no longer matches its project");
    }

    // Backstop against duplicates racing past the pre-storage check in
    // http.ts /clip; same index, transactional this time.
    if (!args.force) {
      const existing = await ctx.db
        .query("documents")
        .withIndex("by_project_sourceUrl", (q) =>
          q.eq("projectId", args.projectId).eq("sourceUrl", args.url)
        )
        .first();
      if (existing) {
        throw new ConvexError({
          code: "duplicate_clip",
          documentId: existing._id,
          clippedAt: existing.uploadedAt,
        });
      }
    }

    const pageTexts = chunkIntoPages(args.articleMarkdown);

    // What the page itself stated, sanitized once here and never rewritten:
    // the published date and byline are ground truth (decision: trust the
    // scrape), so they land on the live columns as "native" and in
    // sourceMetadata, which survives every later Analyze run and human edit.
    const createdDate = sanitizeNativeDate(args.publishedAt, Date.now());
    // The page's own lang is trusted as the language seed, so the translate
    // prompt (translation is prompt-only — never automatic) is right from the
    // moment the clip lands, before Analyze refines the detection. A lying
    // lang header can only mis-word a prompt, never spend anything.
    const seededLanguage = normalizeLanguageCode(args.lang);
    const languagePreference = await languageForProject(ctx, args.projectId);
    const seededDecision = translationDecision({
      sourceLanguageCode: seededLanguage,
      sourceLanguageIsMixed: undefined,
      targetLanguageCode: languagePreference.defaultLanguageCode,
    });
    // The byline junk filter is the PDF author's: CMS residue ("admin",
    // software names) is the same failure mode as Info.Author residue.
    const author = cleanPdfAuthor(args.byline);
    const trimmed = (value: string | undefined) => value?.trim() || undefined;

    const documentId = await ctx.db.insert("documents", {
      projectId: args.projectId,
      name: args.title,
      storageId: args.storageId,
      textStorageId: args.textStorageId,
      sourceUrl: args.url,
      mimeType: "text/html",
      mediaType: "webScrape",
      tags: args.tags.map((t) => t.trim().toLowerCase()),
      metadata: JSON.stringify({
        title: args.title,
        summary: args.description,
        date: args.publishedAt,
        author: args.byline,
        language: args.lang,
        additional: [
          { key: "source url", value: args.url },
          ...(args.siteName ? [{ key: "site", value: args.siteName }] : []),
          ...(args.excerpt ? [{ key: "excerpt", value: args.excerpt }] : []),
          ...(args.ogImage ? [{ key: "og image", value: args.ogImage }] : []),
          ...(args.notes ? [{ key: "notes", value: args.notes }] : []),
        ],
      }),
      pageCount: pageTexts.length,
      status: "parsed",
      uploadedAt: Date.now(),
      ...(createdDate
        ? {
            createdDate: createdDate.value,
            createdDatePrecision: createdDate.precision,
            createdDateSource: "native",
          }
        : {}),
      ...(author ? { author, authorSource: "native" } : {}),
      ...(seededLanguage ? { sourceLanguageCode: seededLanguage } : {}),
      translationLanguageCode: languagePreference.defaultLanguageCode,
      translationStatus:
        seededDecision === "offer"
          ? "offer"
          : seededDecision === "not_needed"
            ? "not_needed"
            : "unknown_language",
      translationVersion: languagePreference.translationVersion,
      sourceMetadata: {
        title: trimmed(args.title),
        author,
        createdDate: createdDate ?? undefined,
        siteName: trimmed(args.siteName),
        description: trimmed(args.description),
        excerpt: trimmed(args.excerpt),
        ogImage: trimmed(args.ogImage),
      },
    });

    for (let pageNum = 0; pageNum < pageTexts.length; pageNum++) {
      const pageId = await ctx.db.insert("pages", {
        documentId,
        projectId: args.projectId,
        pageNumber: pageNum,
        text: pageTexts[pageNum].trim(),
      });
      // One block per paragraph so mentions/citations can anchor to text
      let blockIndex = 0;
      for (const para of pageTexts[pageNum].split(/\n{2,}/)) {
        const text = para.trim();
        if (!text) continue;
        await ctx.db.insert("blocks", {
          documentId,
          pageId,
          pageNumber: pageNum,
          blockId: `clip_p${pageNum}_b${blockIndex++}`,
          blockType: "Text",
          text,
        });
      }
    }

    // Parse already happened client-side — record it as completed so the
    // progress UI reads the same as a PDF's.
    await ctx.db.insert("processingJobs", {
      documentId,
      stage: "parse",
      status: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
    });

    // Clips take the ordinary Analyze path. They used to have their own
    // metadata pass with a hand-maintained subset schema, which had drifted:
    // it omitted suggested_extractions, so buildExtractionSchema returned null
    // and runInitialExtraction bailed — no clip has ever been extracted.
    await ctx.scheduler.runAfter(0, internal.processingStages.runAnalyze, {
      documentId,
    });

    return documentId;
  },
});

/**
 * Human corrections to a clip's metadata, from the popup's post-clip preview
 * (PATCH /clip/metadata). Same bearer-token auth as the other clip endpoints;
 * a field absent from args is untouched, an empty string clears it.
 *
 * Persistence mirrors the app's own editors so the edit reads identically
 * there: title follows updateIdentity's displayName rule; author and the
 * published date follow the native-field rule (clearing leaves a "human"
 * tombstone); site and summary live in the metadata JSON blob the Info tab
 * displays, and any blob edit stamps metadataSource "human" the way
 * updateDocumentMeta does. sourceMetadata stays untouched — it records what
 * the page stated, not what the human corrected.
 */
export const updateClipMetadata = internalMutation({
  args: {
    token: v.string(),
    documentId: v.id("documents"),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    publishedAt: v.optional(v.string()),
    siteName: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = args.token
      ? await ctx.db
          .query("clipperTokens")
          .withIndex("by_token", (q) => q.eq("token", args.token))
          .unique()
      : null;
    const doc = row ? await ctx.db.get(args.documentId) : null;
    const project = doc?.projectId ? await ctx.db.get(doc.projectId) : null;
    if (!row || !doc || !project || project.ownerId !== row.ownerId) {
      // One opaque failure — same oracle reason as clipperTokens.resolve.
      throw new ConvexError("Invalid clipper token or document");
    }

    const patch: Record<string, unknown> = {};
    let blob: Record<string, unknown> = {};
    try {
      blob = doc.metadata ? JSON.parse(doc.metadata) : {};
    } catch {
      /* unparseable blob — rebuild from the edits alone */
    }
    let blobChanged = false;

    if (args.title !== undefined) {
      const title = args.title.trim();
      const keep = title && title !== doc.name;
      patch.displayName = keep ? title : undefined;
      patch.displayNameSource = keep ? "human" : undefined;
      if (title) {
        blob.title = title;
        blobChanged = true;
      }
    }

    if (args.author !== undefined) {
      const author = args.author.trim();
      patch.author = author || undefined;
      patch.authorSource = "human"; // cleared = human tombstone
      blob.author = author || undefined;
      blobChanged = true;
    }

    if (args.publishedAt !== undefined) {
      const text = args.publishedAt.trim();
      if (text) {
        // No future-date guard (Infinity): that guard exists for drifted
        // clocks and hallucinations; a human typing a date is asserting one.
        const date = sanitizeNativeDate(text, Number.POSITIVE_INFINITY);
        if (!date) {
          throw new ConvexError(
            "Not a valid date: use YYYY, YYYY-MM, or YYYY-MM-DD"
          );
        }
        patch.createdDate = date.value;
        patch.createdDatePrecision = date.precision;
        blob.date = date.value;
      } else {
        patch.createdDate = undefined;
        patch.createdDatePrecision = undefined;
        blob.date = undefined;
      }
      patch.createdDateSource = "human"; // cleared = human tombstone
      blobChanged = true;
    }

    if (args.siteName !== undefined) {
      const site = args.siteName.trim();
      const additional = (
        Array.isArray(blob.additional) ? blob.additional : []
      ).filter(
        (entry) => (entry as Record<string, unknown> | null)?.key !== "site"
      );
      if (site) additional.push({ key: "site", value: site });
      blob.additional = additional;
      blobChanged = true;
    }

    if (args.description !== undefined) {
      blob.summary = args.description.trim() || undefined;
      blobChanged = true;
    }

    if (blobChanged) {
      if (doc.metadataSource !== "human") {
        await recordOverride(ctx, {
          documentId: args.documentId,
          field: "metadata",
        });
      }
      patch.metadata = JSON.stringify(blob);
      patch.metadataSource = "human";
    }

    await ctx.db.patch(args.documentId, patch);
    return null;
  },
});

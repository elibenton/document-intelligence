import { internalMutation, internalQuery } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";

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
        return {
          documentId: existing._id,
          projectId: project._id,
          projectName: project.name,
          clippedAt: existing.uploadedAt,
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

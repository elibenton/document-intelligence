import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
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

export const createFromClip = internalMutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const pageTexts = chunkIntoPages(args.articleMarkdown);

    // The clipper extension is not project-aware yet — clips land in the
    // oldest project (the default/test project) so they stay visible.
    const defaultProject = await ctx.db
      .query("projects")
      .withIndex("by_createdAt")
      .order("asc")
      .first();

    const documentId = await ctx.db.insert("documents", {
      projectId: defaultProject?._id,
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
        projectId: defaultProject?._id,
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

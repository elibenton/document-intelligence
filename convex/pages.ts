import { query, mutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Page list for a document, stripped to what the viewer needs (numbers +
 * dimensions). Full page markdown and embeddings stay server-side — they can
 * be many MB per document and were being pushed to every open document page.
 */
export const byDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    return pages.map((p) => ({
      _id: p._id,
      documentId: p.documentId,
      pageNumber: p.pageNumber,
      width: p.width,
      height: p.height,
      textSource: p.textSource,
      viewerRotationAdjustment: p.viewerRotationAdjustment,
    }));
  },
});

const quarterTurnValidator = v.union(v.literal(90), v.literal(-90));

/** Rotate one page relative to the document-wide orientation. */
export const rotatePage = mutation({
  args: {
    documentId: v.id("documents"),
    pageNumber: v.number(),
    degrees: quarterTurnValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("pageNumber", args.pageNumber)
      )
      .unique();
    if (!page) return null;
    const next = ((page.viewerRotationAdjustment ?? 0) + args.degrees + 360) % 360;
    await ctx.db.patch(page._id, {
      viewerRotationAdjustment: next as 0 | 90 | 180 | 270,
    });
    return null;
  },
});

/**
 * Full page text for backend pipelines (relationship extraction etc.) —
 * internal only, so the heavy text never ships to clients.
 */
export const textByDocument = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    return pages.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.text,
    }));
  },
});

/**
 * The document's opening pages only — for pipelines that just need a taste of
 * the content (the rename pass). The by_document index is ordered by page
 * number, so `.take()` returns the first pages rather than an arbitrary few,
 * and a 500-page transcript costs the same read as a one-pager.
 */
export const openingTextByDocument = internalQuery({
  args: { documentId: v.id("documents"), pageCount: v.number() },
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .take(args.pageCount);
    return pages.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.text,
    }));
  },
});

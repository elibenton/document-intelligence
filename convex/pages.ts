import { query, internalQuery } from "./_generated/server";
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

/**
 * One page's display geometry. Replaces pageImages.byPage, which returned a
 * signed PNG URL alongside these dimensions — no raster has been produced since
 * server rendering was removed, so callers were falling back to a hardcoded
 * aspect ratio while the true dimensions sat here all along.
 */
export const dimensionsByPage = query({
  args: { documentId: v.id("documents"), pageNumber: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("pageNumber", args.pageNumber)
      )
      .first();
    if (!page) return null;
    return {
      width: page.width,
      height: page.height,
      rotation: page.viewerRotationAdjustment ?? 0,
    };
  },
});

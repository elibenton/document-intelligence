import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { authedQuery } from "./authz";
import { requireDocument } from "./ownership";

/**
 * Page list for a document, stripped to what the viewer needs (numbers +
 * dimensions). Full page markdown and embeddings stay server-side — they can
 * be many MB per document and were being pushed to every open document page.
 */
export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
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
 * One page's display geometry. Replaces pageImages.byPage, which returned a
 * signed PNG URL alongside these dimensions — no raster has been produced since
 * server rendering was removed, so callers were falling back to a hardcoded
 * aspect ratio while the true dimensions sat here all along.
 */
export const dimensionsByPage = authedQuery({
  args: { documentId: v.id("documents"), pageNumber: v.number() },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
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

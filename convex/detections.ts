import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { authedQuery } from "./authz";
import { requireDocument } from "./ownership";

// Visual objects are produced by the same whole-document Interfaze completion
// as OCR and metadata, then stored here for page overlays.

export const saveDetections = internalMutation({
  args: {
    documentId: v.id("documents"),
    detections: v.array(
      v.object({
        pageNumber: v.number(),
        label: v.string(),
        description: v.string(),
        confidence: v.number(),
        bbox: v.optional(
          v.object({
            x: v.number(),
            y: v.number(),
            width: v.number(),
            height: v.number(),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    // Re-run safety: replace this document's detections
    const existing = await ctx.db
      .query("detections")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const d of existing) await ctx.db.delete(d._id);

    for (const d of args.detections) {
      await ctx.db.insert("detections", {
        documentId: args.documentId,
        ...d,
      });
    }
  },
});

export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    return await ctx.db
      .query("detections")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .take(200);
  },
});

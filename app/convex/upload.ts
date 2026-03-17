import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const generateUploadUrl = mutation(async (ctx) => {
  return await ctx.storage.generateUploadUrl();
});

export const createDocument = mutation({
  args: {
    name: v.string(),
    storageId: v.id("_storage"),
    mimeType: v.string(),
  },
  handler: async (ctx, args) => {
    const documentId = await ctx.db.insert("documents", {
      name: args.name,
      storageId: args.storageId,
      mimeType: args.mimeType,
      status: "uploaded",
      uploadedAt: Date.now(),
    });

    // Create initial processing job for OCR
    await ctx.db.insert("processingJobs", {
      documentId,
      stage: "ocr",
      status: "pending",
    });

    return documentId;
  },
});

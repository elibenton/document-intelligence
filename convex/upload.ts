import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

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

    // Create initial processing job for parse step
    await ctx.db.insert("processingJobs", {
      documentId,
      stage: "parse",
      status: "pending",
    });

    // Automatically kick off the full pipeline (parse + extract people)
    await ctx.scheduler.runAfter(0, api.processing.runFullPipeline, {
      documentId,
    });

    return documentId;
  },
});

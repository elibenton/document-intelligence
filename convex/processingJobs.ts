import { query } from "./_generated/server";
import { v } from "convex/values";

export const byDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
  },
});

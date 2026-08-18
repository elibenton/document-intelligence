import { v } from "convex/values";
import { authedQuery } from "./authz";
import { requireDocument } from "./ownership";

const jobValidator = v.object({
  _id: v.id("processingJobs"),
  _creationTime: v.number(),
  documentId: v.id("documents"),
  stage: v.string(),
  status: v.string(),
  queuedAt: v.optional(v.number()),
  workId: v.optional(v.string()),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  errorMessage: v.optional(v.string()),
});

export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  returns: v.array(jobValidator),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    return await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
  },
});

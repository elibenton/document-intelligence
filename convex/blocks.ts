import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const byDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
  },
});

export const updateType = mutation({
  args: { id: v.id("blocks"), blockType: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { blockType: args.blockType });
  },
});

export const remove = mutation({
  args: { id: v.id("blocks") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const byPage = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("blocks")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .collect();
  },
});

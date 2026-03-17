import { query } from "./_generated/server";
import { v } from "convex/values";

export const listByType = query({
  args: { type: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("entities")
      .withIndex("by_type", (q) => q.eq("type", args.type))
      .order("desc")
      .take(100);
  },
});

export const get = query({
  args: { id: v.id("entities") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

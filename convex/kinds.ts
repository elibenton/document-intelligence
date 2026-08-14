import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Semantic document kinds.
 *
 * These used to carry a default extraction template — the roles to pull out of
 * every document of this kind. Roles now come from the graph pass per document,
 * which is the right level: two reports of the same kind routinely involve
 * entirely different people. What remains is the name itself, which Analyze is
 * shown so it reuses "writ of mandate" rather than inventing a synonym.
 */

/** All document kinds. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("documentKinds").take(200);
  },
});

/** Register a kind the AI named, if it is new. */
export const upsert = internalMutation({
  args: {
    name: v.string(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("documentKinds")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("documentKinds", {
      name: args.name,
      source: args.source,
    });
  },
});

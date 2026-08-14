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
 *
 * Per project, because that reuse list is the whole point: a vocabulary
 * accumulated from someone else's corpus pushes Analyze toward a name this
 * project's documents never use, which is the failure the reuse clause exists
 * to prevent rather than cause.
 */

/** This project's document kinds. */
export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("documentKinds")
      .withIndex("by_project_and_name", (q) => q.eq("projectId", args.projectId))
      .take(200);
  },
});

/** Register a kind the AI named for this project, if it is new. */
export const upsert = internalMutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("documentKinds")
      .withIndex("by_project_and_name", (q) =>
        q.eq("projectId", args.projectId).eq("name", args.name)
      )
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("documentKinds", {
      projectId: args.projectId,
      name: args.name,
      source: args.source,
    });
  },
});

import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { authedQuery } from "./authz";
import { requireProject } from "./ownership";

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

function readKinds(ctx: QueryCtx, projectId: Id<"projects">) {
  return ctx.db
    .query("documentKinds")
    .withIndex("by_project_and_name", (q) => q.eq("projectId", projectId))
    .take(200);
}

/** This project's document kinds. */
export const list = authedQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    return await readKinds(ctx, args.projectId);
  },
});

/** The same list, for the Analyze prompt. See documents.getInternal. */
export const listInternal = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => readKinds(ctx, args.projectId),
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

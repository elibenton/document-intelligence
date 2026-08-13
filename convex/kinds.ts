import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

const templateRoleValidator = v.object({
  role: v.string(),
  question: v.string(),
  entityType: v.string(),
});

/** All document kinds with their extraction templates. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("documentKinds").take(200);
  },
});

/** Create a kind or update its template (used by the AI metadata pass). */
export const upsert = internalMutation({
  args: {
    name: v.string(),
    source: v.string(),
    templateRoles: v.array(templateRoleValidator),
    overwriteTemplate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("documentKinds")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (existing) {
      if (args.overwriteTemplate) {
        await ctx.db.patch(existing._id, { templateRoles: args.templateRoles });
      }
      return existing._id;
    }
    return await ctx.db.insert("documentKinds", {
      name: args.name,
      source: args.source,
      templateRoles: args.templateRoles,
    });
  },
});

/** Human-owned template save-back from the upload review UI. */
export const saveTemplate = mutation({
  args: {
    name: v.string(),
    templateRoles: v.array(templateRoleValidator),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("documentKinds")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        templateRoles: args.templateRoles,
        source: "human",
      });
      return existing._id;
    }
    return await ctx.db.insert("documentKinds", {
      name: args.name,
      source: "human",
      templateRoles: args.templateRoles,
    });
  },
});

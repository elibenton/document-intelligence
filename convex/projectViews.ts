import { v } from "convex/values";
import { authedMutation, authedQuery } from "./authz";

/**
 * Per-project list configuration: the Library and Entities views, and the
 * width the user dragged between them.
 *
 * The backend stores this and nothing more. Property ids, operator names, and
 * group keys are all owned by the client-side registries in src/lib/views —
 * validating them here would mean keeping two copies of the vocabulary in
 * sync, and a stale id is already handled gracefully (applyView skips filters
 * and sorts naming a property it doesn't recognize).
 */

const viewConfigValidator = v.object({
  visibleProperties: v.array(v.string()),
  groupBy: v.optional(v.string()),
  groupSort: v.optional(v.string()),
  hideEmptyGroups: v.optional(v.boolean()),
  filters: v.array(
    v.object({
      property: v.string(),
      operator: v.string(),
      value: v.optional(v.string()),
      values: v.optional(v.array(v.string())),
    })
  ),
  sorts: v.array(
    v.object({
      property: v.string(),
      direction: v.string(),
    })
  ),
});

/** Null when the project has never been customized — the client uses defaults. */
export const get = authedQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projectViews")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .first();
  },
});

/**
 * Patch whichever parts were passed. Each field is independently optional so
 * dragging the divider doesn't have to send the view configs back, and
 * toggling a property doesn't have to send the split ratio.
 */
export const save = authedMutation({
  args: {
    projectId: v.id("projects"),
    splitRatio: v.optional(v.number()),
    library: v.optional(viewConfigValidator),
    entities: v.optional(viewConfigValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { projectId, ...patch } = args;
    // A ratio outside this range leaves one pane too narrow to use. The client
    // clamps while dragging; this is the backstop against a bad write.
    if (patch.splitRatio !== undefined) {
      patch.splitRatio = Math.min(0.8, Math.max(0.2, patch.splitRatio));
    }
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    );

    const existing = await ctx.db
      .query("projectViews")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, defined);
    } else {
      await ctx.db.insert("projectViews", { projectId, ...defined });
    }
    return null;
  },
});

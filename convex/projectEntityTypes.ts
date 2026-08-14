import { internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { TemplateEntityType } from "./projectTemplates";
import { authedMutation, authedQuery } from "./authz";
import { requireProject, requireProjectEntityType } from "./ownership";

/**
 * Entity types a project looks for beyond people and organizations.
 *
 * The two base types are universal and hard-coded; these are the user's
 * additions. Declaring one is a statement about what matters in this project —
 * "vessels", "bank accounts", "properties" — and the graph pass folds it into
 * its type enum on the next document it reads.
 *
 * Deliberately not retroactive. A new type changes what future documents
 * extract; existing documents keep what they found, and re-running one is the
 * explicit way to apply a new type to it. Backfilling every document in a
 * project on a dropdown change would be an unbounded API bill triggered by a
 * form submit.
 */

/** Same shape as the slug used everywhere else, so the key is predictable. */
function toKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** The two the code owns. A project may not redeclare them. */
const RESERVED = new Set(["person", "organization", "people", "organizations"]);

export const list = authedQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    return await ctx.db
      .query("projectEntityTypes")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

/**
 * Read by the graph pass. Internal because it feeds a prompt rather than a
 * screen, and because the action needs it without a user session.
 */
export const listInternal = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projectEntityTypes")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

/**
 * Give a brand-new project its starting entity types, in the creating
 * transaction. Same bargain as `seedCategories`: one key rule shared with
 * `create` below, and an unusable entry is skipped rather than thrown on, so a
 * template can never make a project uncreatable.
 */
export async function seedEntityTypes(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  types: TemplateEntityType[]
): Promise<void> {
  const taken = new Set<string>();
  for (const type of types) {
    const label = type.label.trim();
    const description = type.description.trim();
    if (!label || !description) continue;
    const key = toKey(label);
    if (!key || RESERVED.has(key) || taken.has(key)) continue;
    taken.add(key);
    await ctx.db.insert("projectEntityTypes", {
      projectId,
      key,
      label,
      description,
      createdAt: Date.now(),
    });
  }
}

export const create = authedMutation({
  args: {
    projectId: v.id("projects"),
    label: v.string(),
    description: v.string(),
  },
  returns: v.union(v.id("projectEntityTypes"), v.null()),
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    const label = args.label.trim();
    const description = args.description.trim();
    if (!label || !description) return null;

    const key = toKey(label);
    if (!key || RESERVED.has(key)) return null;

    // The key is what lands in entities.types[], so a duplicate would split one
    // group in two or silently merge two definitions.
    const existing = await ctx.db
      .query("projectEntityTypes")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("key", key)
      )
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("projectEntityTypes", {
      projectId: args.projectId,
      key,
      label,
      description,
      createdAt: Date.now(),
    });
  },
});

/**
 * Stop looking for a type. Entities already found under it are left alone —
 * they are real findings from documents that really were read that way, and
 * deleting them would silently discard work the user asked for.
 */
export const remove = authedMutation({
  args: { id: v.id("projectEntityTypes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireProjectEntityType(ctx, args.id);
    await ctx.db.delete(args.id);
    return null;
  },
});

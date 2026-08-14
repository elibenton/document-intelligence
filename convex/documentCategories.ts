import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { TemplateCategory } from "./projectTemplates";

/**
 * The enforced primary-category taxonomy: user-managed rows that back both
 * the AI classification prompt (convex/analyzePrompt.ts,
 * convex/metadataNode.ts) and the dark half of the DocTypePills pill.
 *
 * Per project. A project's categories are seeded from the template chosen when
 * it was created (convex/projectTemplates.ts) and edited from its settings
 * page; two projects sharing a key share nothing else. `key` is unique within a
 * project, not across the deployment.
 *
 * "other" is a reserved sentinel, not a row — the honest bucket for an
 * off-taxonomy AI answer. It can't be created, edited, or deleted here.
 */
export const OTHER_KEY = "other";

const MAX_LABEL = 60;
const MAX_DESCRIPTION = 500;

/** "Real Estate" -> "real-estate". What documents.primaryCategory stores. */
function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("documentCategories")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return rows.sort((a, b) => a.order - b.order);
  },
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    label: v.string(),
    description: v.string(),
    color: v.string(),
  },
  handler: async (ctx, args) => {
    const label = args.label.trim().slice(0, MAX_LABEL);
    if (!label) throw new Error("Category name is required");
    const key = slugify(label);
    if (!key) {
      throw new Error("Category name must contain a letter or number");
    }
    if (key === OTHER_KEY) {
      throw new Error('"Other" is reserved and can\'t be added as a category');
    }

    const existing = await ctx.db
      .query("documentCategories")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("key", key)
      )
      .first();
    if (existing) {
      throw new Error(`A category named "${existing.label}" already exists`);
    }

    const all = await ctx.db
      .query("documentCategories")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const nextOrder = all.reduce((max, c) => Math.max(max, c.order), -1) + 1;

    return await ctx.db.insert("documentCategories", {
      projectId: args.projectId,
      key,
      label,
      description: args.description.trim().slice(0, MAX_DESCRIPTION),
      color: args.color,
      order: nextOrder,
      createdAt: Date.now(),
    });
  },
});

/**
 * Give a brand-new project its starting categories, in the creating
 * transaction — a project is never briefly visible without them.
 *
 * Lives here rather than in projects.ts so seeded and hand-added categories
 * derive their key, and enforce their length caps, through the same code. A
 * label that slugifies to nothing, to "other", or to a key already taken is
 * skipped rather than thrown on: this runs behind project creation, and a
 * template typo should not be able to make a project uncreatable.
 */
export async function seedCategories(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  categories: TemplateCategory[]
): Promise<void> {
  const taken = new Set<string>();
  let order = 0;
  for (const category of categories) {
    const label = category.label.trim().slice(0, MAX_LABEL);
    if (!label) continue;
    const key = slugify(label);
    if (!key || key === OTHER_KEY || taken.has(key)) continue;
    taken.add(key);
    await ctx.db.insert("documentCategories", {
      projectId,
      key,
      label,
      description: category.description.trim().slice(0, MAX_DESCRIPTION),
      color: category.color,
      order: order++,
      createdAt: Date.now(),
    });
  }
}

/** Edits label/description/color. `key` is immutable — documents reference it. */
export const update = mutation({
  args: {
    id: v.id("documentCategories"),
    label: v.optional(v.string()),
    description: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return;

    const patch: { label?: string; description?: string; color?: string } = {};
    if (args.label !== undefined) {
      const label = args.label.trim().slice(0, MAX_LABEL);
      if (!label) throw new Error("Category name is required");
      patch.label = label;
    }
    if (args.description !== undefined) {
      patch.description = args.description.trim().slice(0, MAX_DESCRIPTION);
    }
    if (args.color !== undefined) {
      patch.color = args.color;
    }
    await ctx.db.patch(args.id, patch);
  },
});

export const remove = mutation({
  args: { id: v.id("documentCategories") },
  handler: async (ctx, args) => {
    const category = await ctx.db.get(args.id);
    if (!category) return;

    // Indexed exact lookup, not a scan — accurate regardless of corpus size.
    // Scoped to the category's own project: another project's documents filed
    // under the same key are a different taxonomy and have no say here.
    const inUse = await ctx.db
      .query("documents")
      .withIndex("by_project_and_category", (q) =>
        q.eq("projectId", category.projectId).eq("primaryCategory", category.key)
      )
      .first();
    if (inUse) {
      throw new Error(
        `"${category.label}" is still assigned to at least one document — reassign or delete those first`
      );
    }
    await ctx.db.delete(args.id);
  },
});

// Read-only per-category cap: this is a Settings breakdown, not a report that
// needs to be exact at unbounded scale.
const BREAKDOWN_LIMIT = 5000;

/**
 * What Analyze has actually filed under each category: per-category document
 * count and the secondary types (primaryKind) observed within it, most
 * common first. Powers the "what the AI extraction has pulled out and put
 * into each of the categories" view in Settings.
 */
export const bySecondaryType = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const categories = await ctx.db
      .query("documentCategories")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const keys = [...categories.map((c) => c.key), OTHER_KEY];

    return await Promise.all(
      keys.map(async (key) => {
        const docs = await ctx.db
          .query("documents")
          .withIndex("by_project_and_category", (q) =>
            q.eq("projectId", args.projectId).eq("primaryCategory", key)
          )
          .take(BREAKDOWN_LIMIT);

        const kindCounts = new Map<string, number>();
        for (const doc of docs) {
          const kind = doc.primaryKind?.trim();
          if (!kind) continue;
          kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
        }

        return {
          categoryKey: key,
          documentCount: docs.length,
          truncated: docs.length === BREAKDOWN_LIMIT,
          kinds: [...kindCounts.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count),
        };
      })
    );
  },
});

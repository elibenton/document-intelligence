import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * The enforced primary-category taxonomy: user-managed rows that back both
 * the AI classification prompt (convex/analyzePrompt.ts,
 * convex/metadataNode.ts) and the dark half of the DocTypePills pill.
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
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("documentCategories").collect();
    return rows.sort((a, b) => a.order - b.order);
  },
});

export const create = mutation({
  args: {
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
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (existing) {
      throw new Error(`A category named "${existing.label}" already exists`);
    }

    const all = await ctx.db.query("documentCategories").collect();
    const nextOrder = all.reduce((max, c) => Math.max(max, c.order), -1) + 1;

    return await ctx.db.insert("documentCategories", {
      key,
      label,
      description: args.description.trim().slice(0, MAX_DESCRIPTION),
      color: args.color,
      order: nextOrder,
      createdAt: Date.now(),
    });
  },
});

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
    const inUse = await ctx.db
      .query("documents")
      .withIndex("by_primaryCategory", (q) => q.eq("primaryCategory", category.key))
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
  args: {},
  handler: async (ctx) => {
    const categories = await ctx.db.query("documentCategories").collect();
    const keys = [...categories.map((c) => c.key), OTHER_KEY];

    return await Promise.all(
      keys.map(async (key) => {
        const docs = await ctx.db
          .query("documents")
          .withIndex("by_primaryCategory", (q) => q.eq("primaryCategory", key))
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

const DEFAULT_CATEGORIES = [
  {
    key: "legal",
    label: "Legal",
    description:
      "Instruments with legal force or filed in a legal proceeding — pleadings, orders, contracts, deeds, subpoenas.",
    color: "violet",
  },
  {
    key: "government",
    label: "Government",
    description:
      "Records a public agency produced or received while administering something — permits, inspection reports, agency correspondence, public-records responses.",
    color: "blue",
  },
  {
    key: "business",
    label: "Business",
    description:
      "Records internal to a private organization — invoices, memos, financial statements, board minutes, personnel files.",
    color: "amber",
  },
  {
    key: "published",
    label: "Published",
    description:
      "Anything issued to a general audience — news articles, press releases, books, academic papers, web pages.",
    color: "teal",
  },
];

/** One-off: materializes the four categories every existing document's
 *  primaryCategory already assumes. Idempotent — run once via
 *  `npx convex run documentCategories:seedDefaults`. */
export const seedDefaults = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("documentCategories").take(1);
    if (existing.length > 0) return;
    for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
      await ctx.db.insert("documentCategories", {
        ...DEFAULT_CATEGORIES[i],
        order: i,
        createdAt: Date.now(),
      });
    }
  },
});

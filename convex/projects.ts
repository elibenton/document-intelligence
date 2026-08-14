import { query, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

import { slugify } from "./slug";

// ---------------------------------------------------------------------------
// List all projects (newest first) with document counts for the picker cards
// ---------------------------------------------------------------------------

export const list = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_createdAt")
      .order("desc")
      .take(100);

    return await Promise.all(
      projects.map(async (project) => {
        // Bounded count — picker cards only need "how big is this, roughly"
        const docs = await ctx.db
          .query("documents")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .take(500);
        return { ...project, documentCount: docs.length };
      })
    );
  },
});

// ---------------------------------------------------------------------------
// Search projects by name (picker search bar)
// ---------------------------------------------------------------------------

export const search = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const q = args.q.trim();
    if (!q) return [];
    const hits = await ctx.db
      .query("projects")
      .withSearchIndex("search_name", (s) => s.search("name", q))
      .take(20);
    return await Promise.all(
      hits.map(async (project) => {
        const docs = await ctx.db
          .query("documents")
          .withIndex("by_project", (s) => s.eq("projectId", project._id))
          .take(500);
        return { ...project, documentCount: docs.length };
      })
    );
  },
});

// ---------------------------------------------------------------------------
// Get a single project
// ---------------------------------------------------------------------------

export const get = query({
  args: { id: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Resolve `/p/:slug`. `.first()` rather than `.unique()` for the same reason
 * `allocateSlug` uses it: an older build could write unchecked slugs, so a
 * deployment may already hold duplicates, and throwing here would take the
 * project page down rather than landing on one of them.
 */
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

// ---------------------------------------------------------------------------
// Create a project (slug de-duplicated with a numeric suffix)
// ---------------------------------------------------------------------------

/**
 * Allocate a slug that no other project holds, suffixing `-2`, `-3`, ... on
 * collision. `exclude` is the project being renamed, so keeping its own slug
 * isn't treated as a conflict.
 *
 * Uses `.first()` rather than `.unique()`: an older build let `update` write
 * unchecked slugs, so a deployment can already hold duplicates, and `.unique()`
 * would throw on them and make every subsequent create fail.
 */
async function allocateSlug(
  ctx: MutationCtx,
  name: string,
  exclude?: Id<"projects">
): Promise<string> {
  const base = slugify(name) || "project";
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!existing || existing._id === exclude) return slug;
  }
}

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("Project name is required");

    return await ctx.db.insert("projects", {
      name,
      slug: await allocateSlug(ctx, name),
      description: args.description,
      createdAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Rename / edit a project
// ---------------------------------------------------------------------------

export const update = mutation({
  args: {
    id: v.id("projects"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, string> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Project name is required");
      patch.name = name;
      // Rename goes through the same allocator as create, so a rename can
      // never mint a duplicate (or empty) slug.
      patch.slug = await allocateSlug(ctx, name, args.id);
    }
    if (args.description !== undefined) patch.description = args.description;
    await ctx.db.patch(args.id, patch);
  },
});

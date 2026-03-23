import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// List all stories
// ---------------------------------------------------------------------------

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("stories")
      .withIndex("by_createdAt")
      .order("desc")
      .take(100);
  },
});

// ---------------------------------------------------------------------------
// List starred stories (for homepage)
// ---------------------------------------------------------------------------

export const listStarred = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("stories")
      .withIndex("by_starred", (q) => q.eq("starred", true))
      .order("desc")
      .take(10);
  },
});

// ---------------------------------------------------------------------------
// Get a single story by ID
// ---------------------------------------------------------------------------

export const get = query({
  args: { id: v.id("stories") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// ---------------------------------------------------------------------------
// Get a single story by slug
// ---------------------------------------------------------------------------

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("stories")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

// ---------------------------------------------------------------------------
// Get all documents in a story
// ---------------------------------------------------------------------------

export const documentsForStory = query({
  args: { storyId: v.id("stories") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("storyDocuments")
      .withIndex("by_story", (q) => q.eq("storyId", args.storyId))
      .collect();

    const docs = await Promise.all(
      links.map((link) => ctx.db.get(link.documentId))
    );
    return docs.filter((d) => d !== null);
  },
});

// ---------------------------------------------------------------------------
// Get entities for a story (transitive through documents → mentions)
// ---------------------------------------------------------------------------

export const entitiesForStory = query({
  args: { storyId: v.id("stories") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("storyDocuments")
      .withIndex("by_story", (q) => q.eq("storyId", args.storyId))
      .collect();

    const entityIds = new Set<string>();
    for (const link of links) {
      const mentions = await ctx.db
        .query("mentions")
        .withIndex("by_document", (q) => q.eq("documentId", link.documentId))
        .collect();
      for (const m of mentions) {
        entityIds.add(m.entityId);
      }
    }

    const entities = await Promise.all(
      [...entityIds].map((id) => ctx.db.get(id as any))
    );
    return entities.filter((e) => e !== null);
  },
});

// ---------------------------------------------------------------------------
// Which stories a document belongs to
// ---------------------------------------------------------------------------

export const storiesForDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("storyDocuments")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();

    const stories = await Promise.all(
      links.map((link) => ctx.db.get(link.storyId))
    );
    return stories.filter((s) => s !== null);
  },
});

// ---------------------------------------------------------------------------
// Starred story summaries (with doc/entity counts for homepage cards)
// ---------------------------------------------------------------------------

export const listStarredWithCounts = query({
  args: {},
  handler: async (ctx) => {
    const stories = await ctx.db
      .query("stories")
      .withIndex("by_starred", (q) => q.eq("starred", true))
      .order("desc")
      .take(10);

    return await Promise.all(
      stories.map(async (story) => {
        const links = await ctx.db
          .query("storyDocuments")
          .withIndex("by_story", (q) => q.eq("storyId", story._id))
          .collect();

        const entityIds = new Set<string>();
        for (const link of links) {
          const mentions = await ctx.db
            .query("mentions")
            .withIndex("by_document", (q) =>
              q.eq("documentId", link.documentId)
            )
            .collect();
          for (const m of mentions) {
            entityIds.add(m.entityId);
          }
        }

        return {
          ...story,
          documentCount: links.length,
          entityCount: entityIds.size,
        };
      })
    );
  },
});

// ---------------------------------------------------------------------------
// Create a story
// ---------------------------------------------------------------------------

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    starred: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const slug = toSlug(args.name);
    return await ctx.db.insert("stories", {
      name: args.name,
      slug,
      description: args.description,
      starred: args.starred ?? false,
      createdAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Update a story
// ---------------------------------------------------------------------------

export const update = mutation({
  args: {
    id: v.id("stories"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, string> = {};
    if (args.name !== undefined) {
      patch.name = args.name;
      patch.slug = toSlug(args.name);
    }
    if (args.description !== undefined) patch.description = args.description;
    await ctx.db.patch(args.id, patch);
  },
});

// ---------------------------------------------------------------------------
// Toggle starred
// ---------------------------------------------------------------------------

export const toggleStar = mutation({
  args: { id: v.id("stories") },
  handler: async (ctx, args) => {
    const story = await ctx.db.get(args.id);
    if (!story) throw new Error("Story not found");
    await ctx.db.patch(args.id, { starred: !story.starred });
  },
});

// ---------------------------------------------------------------------------
// Add a document to a story
// ---------------------------------------------------------------------------

export const addDocument = mutation({
  args: {
    storyId: v.id("stories"),
    documentId: v.id("documents"),
  },
  handler: async (ctx, args) => {
    // Check for duplicate
    const existing = await ctx.db
      .query("storyDocuments")
      .withIndex("by_story", (q) => q.eq("storyId", args.storyId))
      .collect();
    if (existing.some((link) => link.documentId === args.documentId)) {
      return; // already linked
    }
    await ctx.db.insert("storyDocuments", {
      storyId: args.storyId,
      documentId: args.documentId,
      addedAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Remove a document from a story
// ---------------------------------------------------------------------------

export const removeDocument = mutation({
  args: {
    storyId: v.id("stories"),
    documentId: v.id("documents"),
  },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("storyDocuments")
      .withIndex("by_story", (q) => q.eq("storyId", args.storyId))
      .collect();
    for (const link of links) {
      if (link.documentId === args.documentId) {
        await ctx.db.delete(link._id);
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Backfill slugs on stories that don't have one
// ---------------------------------------------------------------------------

export const backfillSlugs = mutation({
  args: {},
  handler: async (ctx) => {
    const stories = await ctx.db
      .query("stories")
      .withIndex("by_createdAt")
      .order("desc")
      .take(100);
    let updated = 0;
    for (const story of stories) {
      if (!story.slug) {
        await ctx.db.patch(story._id, { slug: toSlug(story.name) });
        updated++;
      }
    }
    return { updated };
  },
});

// ---------------------------------------------------------------------------
// Delete a story (and its join rows)
// ---------------------------------------------------------------------------

export const remove = mutation({
  args: { id: v.id("stories") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("storyDocuments")
      .withIndex("by_story", (q) => q.eq("storyId", args.id))
      .collect();
    for (const link of links) {
      await ctx.db.delete(link._id);
    }
    await ctx.db.delete(args.id);
  },
});

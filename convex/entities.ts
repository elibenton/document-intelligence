import { query } from "./_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Get a single entity
// ---------------------------------------------------------------------------

export const get = query({
  args: { id: v.id("entities") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// ---------------------------------------------------------------------------
// List entities by type
// ---------------------------------------------------------------------------

export const listByType = query({
  args: { type: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("entities")
      .withIndex("by_type", (q) => q.eq("type", args.type))
      .order("desc")
      .take(100);
  },
});

// ---------------------------------------------------------------------------
// List all entities (for homepage grouped display)
// ---------------------------------------------------------------------------

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("entities").order("desc").take(200);
  },
});

// ---------------------------------------------------------------------------
// Get all entities that have mentions in a given document,
// including their global documentCount for cross-doc display.
// ---------------------------------------------------------------------------

export const byDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();

    // Deduplicate entity IDs and count local mentions
    const localCounts = new Map<string, number>();
    const entityIds = new Set<string>();
    for (const m of mentions) {
      entityIds.add(m.entityId);
      localCounts.set(m.entityId, (localCounts.get(m.entityId) ?? 0) + 1);
    }

    // Fetch each entity record
    const entities = await Promise.all(
      [...entityIds].map((id) => ctx.db.get(id as typeof mentions[0]["entityId"]))
    );

    return entities
      .filter((e) => e !== null)
      .map((e) => ({
        _id: e._id,
        name: e.name,
        type: e.type,
        documentCount: e.documentCount,
        mentionCount: e.mentionCount,
        localMentionCount: localCounts.get(e._id) ?? 0,
        isCustom: e.isCustom,
      }));
  },
});

// ---------------------------------------------------------------------------
// Get entity by name slug (for /entity/:slug URL)
// ---------------------------------------------------------------------------

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    // Reconstruct name from slug for search
    const searchTerm = args.slug.replace(/-/g, " ");
    const results = await ctx.db
      .query("entities")
      .withSearchIndex("search_name", (q) => q.search("name", searchTerm))
      .take(20);

    // Match by slug: normalize entity name the same way
    const toSlug = (name: string) =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

    return results.find((e) => toSlug(e.name) === args.slug) ?? null;
  },
});

// ---------------------------------------------------------------------------
// Get which documents a given entity appears in (for cross-doc dropdown)
// ---------------------------------------------------------------------------

export const documentsForEntity = query({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args) => {
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_entity", (q) => q.eq("entityId", args.entityId))
      .collect();

    // Group by document
    const docMentions = new Map<string, number>();
    for (const m of mentions) {
      docMentions.set(m.documentId, (docMentions.get(m.documentId) ?? 0) + 1);
    }

    // Fetch document records
    const docs = await Promise.all(
      [...docMentions.keys()].map((id) =>
        ctx.db.get(id as typeof mentions[0]["documentId"])
      )
    );

    return docs
      .filter((d) => d !== null)
      .map((d) => ({
        _id: d._id,
        name: d.name,
        mentionCount: docMentions.get(d._id) ?? 0,
      }));
  },
});

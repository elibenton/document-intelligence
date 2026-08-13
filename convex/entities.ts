import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Get a single entity
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// List entities by type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// List all entities (for homepage grouped display)
// ---------------------------------------------------------------------------

export const listAll = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("entities")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(200);
  },
});

// ---------------------------------------------------------------------------
// Pin an entity in its type group
// ---------------------------------------------------------------------------

export const setStarred = mutation({
  args: { id: v.id("entities"), starred: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { starred: args.starred });
    return null;
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

/**
 * Resolve `/entity/:slug`. Entities are per-project — the same real-world
 * person in two projects is two rows — so `projectId` scopes the lookup.
 * It stays optional only so links minted before scoping existed still resolve
 * (to an arbitrary project's match); every in-app link passes it.
 */
export const getBySlug = query({
  args: { slug: v.string(), projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    // Reconstruct name from slug for search
    const searchTerm = args.slug.replace(/-/g, " ");
    const results = await ctx.db
      .query("entities")
      .withSearchIndex("search_name", (q) =>
        args.projectId
          ? q.search("name", searchTerm).eq("projectId", args.projectId)
          : q.search("name", searchTerm)
      )
      .take(50);

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

// ---------------------------------------------------------------------------
// All of an entity's mentions with snippets, grouped by document
// (entity page "Appears In" detail)
// ---------------------------------------------------------------------------

export const mentionsForEntity = query({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args) => {
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_entity", (q) => q.eq("entityId", args.entityId))
      .take(500);

    // Group mention rows by document, preserving page order
    const byDoc = new Map<
      (typeof mentions)[0]["documentId"],
      (typeof mentions)[0][]
    >();
    for (const m of mentions) {
      const rows = byDoc.get(m.documentId) ?? [];
      rows.push(m);
      byDoc.set(m.documentId, rows);
    }

    // Page dimensions per pageId (needed to scale bboxes in hover previews)
    const pageDims = new Map<
      string,
      { width?: number; height?: number }
    >();

    const results = [];
    for (const [documentId, rows] of byDoc) {
      const doc = await ctx.db.get(documentId);
      if (!doc) continue;
      const fileUrl = await ctx.storage.getUrl(doc.storageId);

      const mentionRows = [];
      for (const m of [...rows].sort((a, b) => a.pageNumber - b.pageNumber)) {
        if (!pageDims.has(m.pageId)) {
          const page = await ctx.db.get(m.pageId);
          pageDims.set(m.pageId, {
            width: page?.width,
            height: page?.height,
          });
        }
        const dims = pageDims.get(m.pageId)!;
        mentionRows.push({
          pageNumber: m.pageNumber,
          snippet: m.text.slice(0, 240),
          bbox: m.bbox ?? null,
          pageWidth: dims.width ?? null,
          pageHeight: dims.height ?? null,
        });
      }

      results.push({
        document: {
          _id: doc._id,
          name: doc.name,
          mediaType: doc.mediaType ?? "pdf",
        },
        fileUrl,
        mentions: mentionRows,
      });
    }
    return results;
  },
});

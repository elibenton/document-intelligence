import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./authz";
import {
  requireDocument,
  requireEntity,
  requireProject,
  ownedProjects,
} from "./ownership";

// ---------------------------------------------------------------------------
// Get a single entity
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// List entities by type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// List all entities (for homepage grouped display)
// ---------------------------------------------------------------------------

export const listAll = authedQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    // Ordered by mentionCount, not creation time: the client sorts by mentions,
    // so a creation-ordered cap silently hid the entities it most wanted.
    return await ctx.db
      .query("entities")
      .withIndex("by_project_and_mentions", (q) =>
        q.eq("projectId", args.projectId)
      )
      .order("desc")
      .take(200);
  },
});

// ---------------------------------------------------------------------------
// Pin an entity in its type group
// ---------------------------------------------------------------------------

export const setStarred = authedMutation({
  args: { id: v.id("entities"), starred: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEntity(ctx, args.id);
    await ctx.db.patch(args.id, { starred: args.starred });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Get all entities that have mentions in a given document,
// including their global documentCount for cross-doc display.
// ---------------------------------------------------------------------------

/**
 * The type to group an entity under, preferring the stable vocabulary.
 *
 * An entity carries both a legacy `type` and a stable `types[]`. Only the
 * latter is maintained, so the first current type in it wins; the legacy value
 * is the fallback for rows written before `types[]` existed.
 */
function displayType(entity: Doc<"entities">): string {
  const current = entity.types?.find(
    (t) => t === "person" || t === "organization"
  );
  return current ?? entity.types?.[0] ?? entity.type;
}

export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
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

    // The role each entity plays in *this* document — "declarant", "attorney",
    // "respondent". Read in one indexed pass rather than per entity, and a
    // human's answer wins over the pass's when both exist.
    const roles = await ctx.db
      .query("entityRoles")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const roleByEntity = new Map<string, string>();
    for (const row of roles) {
      const existing = roleByEntity.get(row.entityId);
      if (!existing || row.source === "human") {
        roleByEntity.set(row.entityId, row.role);
      }
    }

    return entities
      .filter((e) => e !== null)
      .map((e) => ({
        _id: e._id,
        name: e.name,
        // The type the sidebar groups by, preferring the stable vocabulary.
        //
        // `resolveEntity` unions a new type into `types[]` but never rewrites
        // the legacy `type` — despite the schema comment claiming they stay in
        // sync. So an entity the extraction path first saw as a "place", which
        // the graph pass has since resolved as an organization, still carries
        // `type: "places"` and would group under a heading nothing writes to.
        type: displayType(e),
        role: roleByEntity.get(e._id),
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
export const getBySlug = authedQuery({
  args: { slug: v.string(), projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    if (args.projectId) {
      await requireProject(ctx, args.projectId);
      return await ctx.db
        .query("entities")
        .withIndex("by_slug_and_project", (q) =>
          q.eq("slug", args.slug).eq("projectId", args.projectId)
        )
        .first();
    }
    // The un-scoped fallback for links minted before entities were per-project
    // (see EntityPage). It cannot stay a bare `.first()`: that would hand back
    // whichever project happened to sort first, including someone else's. The
    // same slug appears at most once per project, so collecting them is bounded
    // by the number of projects holding that name.
    const mine = new Set((await ownedProjects(ctx)).map((p) => p._id));
    const matches = await ctx.db
      .query("entities")
      .withIndex("by_slug_and_project", (q) => q.eq("slug", args.slug))
      .collect();
    return (
      matches.find((e) => e.projectId && mine.has(e.projectId)) ?? null
    );
  },
});

// ---------------------------------------------------------------------------
// Get which documents a given entity appears in (for cross-doc dropdown)
// ---------------------------------------------------------------------------

export const documentsForEntity = authedQuery({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args) => {
    await requireEntity(ctx, args.entityId);
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

export const mentionsForEntity = authedQuery({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args) => {
    await requireEntity(ctx, args.entityId);
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

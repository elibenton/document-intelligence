import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { authedMutation, authedQuery } from "./authz";
import { displayEntityType, entityTypeKey } from "./entityType";
import {
  LEGACY_TO_STABLE,
  recountEntity,
  resolveEntity,
  STABLE_TO_LEGACY,
} from "./entityResolution";
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

/** Page size of each type group in the sidebar — never more on screen. */
const SIDEBAR_PER_TYPE = 50;
/**
 * Ceiling on the scan behind the sidebar. Far above any observed project
 * (largest measured: ~1,200); if a project ever exceeds it, `totalIsFloor`
 * says so rather than lying quietly. The scan is what makes the rest cheap:
 * the whole-project per-type totals, the starred rescue, and the per-type
 * slices all come out of this one indexed read — which is also why no new
 * index is needed: counting requires reading the rows regardless (Convex has
 * no count operator), so a (projectId, type) index would only duplicate work
 * the count already pays for.
 */
const SIDEBAR_SCAN_CAP = 2000;

export const listAll = authedQuery({
  args: {
    projectId: v.id("projects"),
    /**
     * Page offset per type group, keyed by entityTypeKey — each group shows
     * one 50-row window at a time. Absent key = the first page.
     */
    typeOffsets: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    // Ordered by mentionCount, not creation time: the client sorts by
    // mentions, so a creation-ordered cap silently hid the entities it most
    // wanted. Each type group serves one exact 50-row window over a
    // starred-first sequence: a star is a human signal the first page must
    // not hide (13 starred entities were invisible before this rule), so
    // starred rows claim page-one slots and the top unstarred fill the rest.
    // The client re-sorts by mentions, so display order is unaffected.
    const rows = await ctx.db
      .query("entities")
      .withIndex("by_project_and_mentions", (q) =>
        q.eq("projectId", args.projectId)
      )
      .order("desc")
      .take(SIDEBAR_SCAN_CAP);

    const byType = new Map<string, typeof rows>();
    for (const e of rows) {
      const key = entityTypeKey(displayEntityType(e));
      const group = byType.get(key);
      if (group) group.push(e);
      else byType.set(key, [e]);
    }

    const entities: typeof rows = [];
    const perType: Record<
      string,
      { total: number; offset: number; shown: number }
    > = {};
    for (const [key, group] of byType) {
      const requested = args.typeOffsets?.[key];
      const offset =
        typeof requested === "number" && Number.isFinite(requested)
          ? Math.min(
              Math.max(Math.floor(requested), 0),
              Math.max(group.length - 1, 0)
            )
          : 0;
      // Both halves keep the scan's mention order, so pages stay stable.
      const ordered = [
        ...group.filter((e) => e.starred === true),
        ...group.filter((e) => e.starred !== true),
      ];
      const kept = ordered.slice(offset, offset + SIDEBAR_PER_TYPE);
      entities.push(...kept);
      perType[key] = { total: group.length, offset, shown: kept.length };
    }

    return {
      entities,
      /** Whole-project row count per type group — what the headers show. */
      perType,
      total: rows.length,
      /** True when the scan cap was hit and every total is a floor. */
      totalIsFloor: rows.length === SIDEBAR_SCAN_CAP,
    };
  },
});

/**
 * The full project entity list, paginated — the sidebar's escape hatch for
 * everything beyond its cap. Same order as the sidebar: most mentioned first.
 */
export const listPaginated = authedQuery({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    return await ctx.db
      .query("entities")
      .withIndex("by_project_and_mentions", (q) =>
        q.eq("projectId", args.projectId)
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// ---------------------------------------------------------------------------
// Pin an entity in its type group
// ---------------------------------------------------------------------------

/**
 * Human rename. The old name joins the aliases (deduped, case-insensitive)
 * so search, merge matching, and mention text still resolve; the slug is
 * deliberately untouched — every link in the app is minted from the stored
 * slug, so freezing it means nothing breaks and only the URL cosmetically
 * shows the old name. Rename is the one *sticky* editable field: an entity
 * with no name is meaningless, so empty commits are rejected rather than
 * treated as "hand it back to the AI".
 */
export const rename = authedMutation({
  args: { id: v.id("entities"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entity = await requireEntity(ctx, args.id);
    const name = args.name.trim().replace(/\s+/g, " ");
    if (!name) throw new Error("An entity needs a name");
    if (name === entity.name) return null;
    const aliasSet = new Set(entity.aliases.map((a) => a.toLowerCase()));
    const aliases =
      aliasSet.has(entity.name.toLowerCase()) ||
      entity.name.toLowerCase() === name.toLowerCase()
        ? entity.aliases
        : [...entity.aliases, entity.name];
    await ctx.db.patch(args.id, {
      name,
      aliases,
      nameSource: "human",
    });
    return null;
  },
});

/**
 * Human retype: writes the stable types[] and keeps the legacy single `type`
 * in step with types[0] — the one write path that honors the schema's
 * "kept in sync" comment. Extraction's type-union stands down once stamped.
 */
export const setTypes = authedMutation({
  args: { id: v.id("entities"), types: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEntity(ctx, args.id);
    const types = [
      ...new Set(args.types.map((t) => t.trim().toLowerCase()).filter(Boolean)),
    ];
    if (types.length === 0) throw new Error("An entity needs a type");
    await ctx.db.patch(args.id, {
      types,
      type: STABLE_TO_LEGACY[types[0]] ?? types[0],
      typesSource: "human",
    });
    return null;
  },
});

/** Teach an alias by hand — the direct way to make "IRS" find "Internal
 *  Revenue Service", no merge required. */
export const addAlias = authedMutation({
  args: { id: v.id("entities"), alias: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entity = await requireEntity(ctx, args.id);
    const alias = args.alias.trim().replace(/\s+/g, " ");
    if (!alias) throw new Error("An alias needs text");
    const lower = alias.toLowerCase();
    if (
      lower === entity.name.toLowerCase() ||
      entity.aliases.some((a) => a.toLowerCase() === lower)
    ) {
      return null;
    }
    await ctx.db.patch(args.id, { aliases: [...entity.aliases, alias] });
    return null;
  },
});

export const removeAlias = authedMutation({
  args: { id: v.id("entities"), alias: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entity = await requireEntity(ctx, args.id);
    const lower = args.alias.trim().toLowerCase();
    await ctx.db.patch(args.id, {
      aliases: entity.aliases.filter((a) => a.toLowerCase() !== lower),
    });
    return null;
  },
});

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

// The shared display-type rule — see convex/entityType.ts.
const displayType = displayEntityType;

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
        // Every spelling this entity has carried (renames and merges teach
        // them) — the sidebar matches all of them against the visible text,
        // so "Eli Cohen" still highlights a transcript that only says "Eli".
        aliases: e.aliases,
      }));
  },
});

/**
 * Candidate entities for reassigning a document's link — a project-scoped name
 * search, driving the "is this actually someone else?" picker in the sidebar.
 */
export const reassignOptions = authedQuery({
  args: { documentId: v.id("documents"), query: v.string() },
  handler: async (ctx, args) => {
    const document = await requireDocument(ctx, args.documentId);
    const q = args.query.trim();
    if (q.length < 2) return [];
    const rows = await ctx.db
      .query("entities")
      .withSearchIndex("search_name", (s) =>
        s.search("name", q).eq("projectId", document.projectId)
      )
      .take(8);
    return rows.map((e) => ({
      _id: e._id,
      name: e.name,
      type: displayType(e),
      documentCount: e.documentCount,
    }));
  },
});

/**
 * "This document's Michael is a different Michael": move ONE document's link
 * — its mentions, roles, relationships, and speaker rows — from `entityId` to
 * another entity, leaving every other document's link untouched.
 *
 * The target is an existing entity (picked from reassignOptions) or a name,
 * which goes through the shared resolver: an exact/alias match links rather
 * than duplicating, anything else becomes a new entity, and lookalikes queue
 * merge suggestions exactly as extraction's do.
 */
export const reassignInDocument = authedMutation({
  args: {
    documentId: v.id("documents"),
    entityId: v.id("entities"),
    targetEntityId: v.optional(v.id("entities")),
    name: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await requireDocument(ctx, args.documentId);
    const source = await requireEntity(ctx, args.entityId);
    if (source.projectId !== document.projectId) {
      throw new Error("Reassignment stays within the document's project");
    }
    if ((args.targetEntityId === undefined) === (args.name === undefined)) {
      throw new Error("Pass exactly one of targetEntityId or name");
    }

    let targetId;
    if (args.targetEntityId !== undefined) {
      const target = await requireEntity(ctx, args.targetEntityId);
      if (target.projectId !== document.projectId) {
        throw new Error("Reassignment stays within the document's project");
      }
      targetId = target._id;
    } else {
      const name = args.name!.trim().replace(/\s+/g, " ");
      if (!name) throw new Error("An entity needs a name");
      const resolved = await resolveEntity(ctx, {
        name,
        // The person is the same *kind* of thing they were, just a different
        // instance of it.
        stableType:
          source.types?.[0] ?? LEGACY_TO_STABLE[source.type] ?? "person",
        documentId: args.documentId,
      });
      targetId = resolved.entityId;
    }
    if (targetId === source._id) return null;

    // This document's mentions move wholesale — they are occurrences of a
    // name, and the reassignment is precisely the statement that in THIS
    // document that name means the target.
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const mention of mentions) {
      if (mention.entityId === source._id) {
        await ctx.db.patch(mention._id, { entityId: targetId });
      }
    }

    // Roles, skipping ones the target already asserts here.
    const roles = await ctx.db
      .query("entityRoles")
      .withIndex("by_entity_and_document", (q) =>
        q.eq("entityId", source._id).eq("documentId", args.documentId)
      )
      .collect();
    const targetRoles = await ctx.db
      .query("entityRoles")
      .withIndex("by_entity_and_document", (q) =>
        q.eq("entityId", targetId).eq("documentId", args.documentId)
      )
      .collect();
    // Tracked as a live set, not the snapshot alone: two identical source
    // roles must not both move and land as duplicates on the target.
    const rolesOnTarget = new Set(targetRoles.map((r) => r.role));
    for (const role of roles) {
      if (rolesOnTarget.has(role.role)) {
        await ctx.db.delete(role._id);
      } else {
        rolesOnTarget.add(role.role);
        await ctx.db.patch(role._id, { entityId: targetId });
      }
    }

    // This document's relationship endpoints follow; an edge that would now
    // connect the target to itself is deleted rather than kept as a loop.
    const relationships = await ctx.db
      .query("relationships")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const rel of relationships) {
      const nextSource =
        rel.sourceEntityId === source._id ? targetId : rel.sourceEntityId;
      const nextTarget =
        rel.targetEntityId === source._id ? targetId : rel.targetEntityId;
      if (nextSource === rel.sourceEntityId && nextTarget === rel.targetEntityId) {
        continue;
      }
      if (nextSource === nextTarget) {
        await ctx.db.delete(rel._id);
      } else {
        await ctx.db.patch(rel._id, {
          sourceEntityId: nextSource,
          targetEntityId: nextTarget,
        });
      }
    }

    // A named speaker linked to the old entity follows too — the voice was
    // the same misidentification.
    const speakers = await ctx.db
      .query("documentSpeakers")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const speaker of speakers) {
      if (speaker.entityId === source._id) {
        await ctx.db.patch(speaker._id, { entityId: targetId });
      }
    }

    await recountEntity(ctx, source._id);
    await recountEntity(ctx, targetId);
    return null;
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

    // Sorted by local mention count: the documents where this entity matters
    // most lead. The row carries what the entity page renders — title, date,
    // and the type-pill fields the row always had but never returned.
    return docs
      .filter((d) => d !== null)
      .map((d) => ({
        _id: d._id,
        name: d.name,
        displayName: d.displayName,
        documentDate: d.documentDate,
        documentDatePrecision: d.documentDatePrecision,
        metadata: d.metadata,
        primaryCategory: d.primaryCategory,
        primaryKind: d.primaryKind,
        mediaType: d.mediaType,
        projectId: d.projectId,
        mentionCount: docMentions.get(d._id) ?? 0,
      }))
      .sort((a, b) => b.mentionCount - a.mentionCount);
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

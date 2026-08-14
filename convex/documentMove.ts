import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CASCADE_BATCH, sweepOrphanEntities } from "./documents";
import { slugify } from "./slug";
import { authedMutation } from "./authz";
import { requireDocument, requireProject } from "./ownership";

/**
 * Move a document to another project, after the fact.
 *
 * `documents.projectId` is one field, but a project owns more than a list of
 * documents, so four kinds of thing have to follow it:
 *
 *  1. **Denormalized project ids** on `pages`, `pageTranslations` and
 *     `annotations`. These exist so search and notes can filter by project
 *     without loading the document row; a stale one means the moved document's
 *     pages keep answering the old project's searches and never answer the new
 *     one's.
 *  2. **The entity graph.** Entities are per-project rows, so the document's
 *     mentions, roles and relationships are repointed onto same-named entities
 *     in the target project, creating them where they don't exist yet and
 *     deleting the source entities this document was the last evidence for.
 *     Nothing is re-extracted and no API call is made: the join key is the
 *     entity's slug, which is exactly what a human merge already normalizes.
 *  3. **The kind vocabulary.** The document's kinds are registered in the
 *     target project so Analyze is shown them as names worth reusing.
 *  4. **Nothing about the category.** `primaryCategory` is a key into a
 *     taxonomy the target project may not share. It is deliberately left as
 *     written — the pill falls back to the kind alone, and re-analyzing the
 *     document is the honest way to re-file it. Rewriting it here would mean
 *     guessing which of the target's categories the old one meant.
 *
 * Only the document row and its kinds move in the calling transaction; the rest
 * drains a bounded batch at a time, the same shape as `drainDeletion`. The
 * document therefore appears in its new project immediately and its graph
 * catches up, which is the same bargain every other asynchronous stage in this
 * app makes.
 */

/** Phases of `drainMove`, in the order they run. */
const MOVE_PHASE = {
  pages: 0,
  pageTranslations: 1,
  annotations: 2,
  mentions: 3,
  entityRoles: 4,
  relationships: 5,
  sweep: 6,
  done: 7,
} as const;

/** The tables carrying a denormalized `projectId`, in phase order. */
const DENORMALIZED_TABLES = [
  "pages",
  "pageTranslations",
  "annotations",
] as const;

export const moveToProject = authedMutation({
  args: {
    documentId: v.id("documents"),
    targetProjectId: v.id("projects"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    await requireProject(ctx, args.targetProjectId);
    const document = await ctx.db.get(args.documentId);
    if (!document) throw new Error("Document not found");
    if (document.projectId === args.targetProjectId) return null;

    const target = await ctx.db.get(args.targetProjectId);
    if (!target) throw new Error("Target project not found");

    // The same check `upload.createDocument` makes, for the same reason: two
    // rows for one file diverge the moment either is re-analyzed, and the
    // library gives no hint they are the same document.
    if (document.contentHash) {
      const clash = await ctx.db
        .query("documents")
        .withIndex("by_project_hash", (q) =>
          q
            .eq("projectId", args.targetProjectId)
            .eq("contentHash", document.contentHash)
        )
        .first();
      if (clash) {
        throw new Error(
          `“${target.name}” already has this file as “${clash.displayName ?? clash.name}”`
        );
      }
    }

    await ctx.db.patch(args.documentId, { projectId: args.targetProjectId });

    // Bounded by MAX_KINDS, so this belongs in the calling transaction rather
    // than a drain phase.
    for (const name of document.kinds ?? []) {
      await ctx.runMutation(internal.kinds.upsert, {
        projectId: args.targetProjectId,
        name,
        source: document.kindSource === "human" ? "human" : "ai",
      });
    }

    await ctx.scheduler.runAfter(0, internal.documentMove.drainMove, {
      documentId: args.documentId,
      targetProjectId: args.targetProjectId,
      phase: MOVE_PHASE.pages,
      cursor: null,
      orphanCandidates: [],
    });
    return null;
  },
});

/**
 * One bounded step of a move, rescheduling itself until done.
 *
 * Every phase paginates rather than re-reading the head of an index. The
 * deletion cascade can `take` the same first batch repeatedly because deleting
 * a row removes it from the index it was read from; a move only *patches*, so
 * the rows stay exactly where they were and a `take` loop would either spin
 * forever or stop early. The cursor is the difference.
 *
 * `orphanCandidates` rides in the arguments for the same reason it does in
 * `drainDeletion`: it is the only state that has to survive between
 * transactions, and it is bounded by the document's own distinct entities.
 */
export const drainMove = internalMutation({
  args: {
    documentId: v.id("documents"),
    targetProjectId: v.id("projects"),
    phase: v.number(),
    cursor: v.union(v.string(), v.null()),
    orphanCandidates: v.array(v.id("entities")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { documentId, targetProjectId, phase } = args;
    let orphanCandidates = args.orphanCandidates;
    let cursor: string | null = null;
    let more = false;

    if (phase <= MOVE_PHASE.annotations) {
      cursor = await restampProjectId(
        ctx,
        DENORMALIZED_TABLES[phase],
        documentId,
        targetProjectId,
        args.cursor
      );
      more = cursor !== null;
    } else if (phase === MOVE_PHASE.mentions) {
      const result = await moveMentions(
        ctx,
        documentId,
        targetProjectId,
        args.cursor,
        orphanCandidates
      );
      cursor = result.cursor;
      more = cursor !== null;
      orphanCandidates = result.orphanCandidates;
    } else if (phase === MOVE_PHASE.entityRoles) {
      const result = await moveEntityRoles(
        ctx,
        documentId,
        targetProjectId,
        args.cursor,
        orphanCandidates
      );
      cursor = result.cursor;
      more = cursor !== null;
      orphanCandidates = result.orphanCandidates;
    } else if (phase === MOVE_PHASE.relationships) {
      const result = await moveRelationships(
        ctx,
        documentId,
        targetProjectId,
        args.cursor,
        orphanCandidates
      );
      cursor = result.cursor;
      more = cursor !== null;
      orphanCandidates = result.orphanCandidates;
    } else if (phase === MOVE_PHASE.sweep) {
      orphanCandidates = await sweepOrphanEntities(ctx, orphanCandidates);
      more = orphanCandidates.length > 0;
    } else {
      return null;
    }

    const next = more ? phase : phase + 1;
    if (next >= MOVE_PHASE.done) return null;
    await ctx.scheduler.runAfter(0, internal.documentMove.drainMove, {
      documentId,
      targetProjectId,
      phase: next,
      cursor: more ? cursor : null,
      orphanCandidates,
    });
    return null;
  },
});

/**
 * Re-stamp one page of a table that denormalizes the document's project.
 * Returns the cursor to resume from, or null when the table is done.
 */
async function restampProjectId(
  ctx: MutationCtx,
  table: (typeof DENORMALIZED_TABLES)[number],
  documentId: Id<"documents">,
  targetProjectId: Id<"projects">,
  cursor: string | null
): Promise<string | null> {
  // Same cast as `drainTable` in documents.ts, for the same reason: every table
  // here has a `by_document` index keyed on documentId first, but a union of
  // table names resolves to no common builder signature.
  const page = await ctx.db
    .query(table as "pages")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .paginate({ cursor, numItems: CASCADE_BATCH });

  for (const row of page.page) {
    if (row.projectId === targetProjectId) continue;
    await ctx.db.patch(row._id, { projectId: targetProjectId });
  }
  return page.isDone ? null : page.continueCursor;
}

/**
 * The target project's version of a source-project entity, created if this is
 * the first document to bring it across.
 *
 * Matched on `slug`, which is `slugify(name)` and never changes after creation
 * — a merge deletes the loser rather than renaming the winner — so it is the
 * same identity the rest of the app resolves `/entity/:slug` by. Counts start
 * at zero on a freshly created twin and are added to by the caller.
 *
 * `aliases` come across because they are a claim about who this is, and true
 * wherever the entity appears. `starred` deliberately does not: it is curation
 * of one project's sidebar, not a fact about the entity, and copying it strands
 * empty rows. A starred twin is invisible to `sweepOrphanEntities` — which
 * spares starred entities on purpose — so a document that moves in and out
 * again leaves a 0-mention entity behind forever. Observed, not theorized.
 */
async function twinEntity(
  ctx: MutationCtx,
  source: Doc<"entities">,
  targetProjectId: Id<"projects">
): Promise<Id<"entities">> {
  const slug = source.slug ?? slugify(source.name);
  const existing = await ctx.db
    .query("entities")
    .withIndex("by_slug_and_project", (q) =>
      q.eq("slug", slug).eq("projectId", targetProjectId)
    )
    .first();
  if (existing) return existing._id;

  return await ctx.db.insert("entities", {
    projectId: targetProjectId,
    name: source.name,
    type: source.type,
    types: source.types,
    mentionCount: 0,
    documentCount: 0,
    avgConfidence: source.avgConfidence,
    aliases: source.aliases,
    isCustom: source.isCustom,
    slug,
  });
}

/**
 * Repoint one page of this document's mentions onto target-project entities.
 *
 * Counts are adjusted arithmetically rather than recounted, exactly as
 * `drainMentions` does and for the same reason: recounting a common entity's
 * mentions is thousands of reads per entity. `mentionCount` moves by what this
 * batch actually moved; `documentCount` moves by one on each side, on the batch
 * that takes the source's last mention here and the batch that gives the twin
 * its first.
 *
 * `avgConfidence` is deliberately left alone on both rows. It is a display
 * number, and making it exact would mean reading every remaining mention of
 * every affected entity — the one cost this whole approach exists to avoid.
 */
async function moveMentions(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  targetProjectId: Id<"projects">,
  cursor: string | null,
  orphanCandidates: Id<"entities">[]
): Promise<{ cursor: string | null; orphanCandidates: Id<"entities">[] }> {
  const page = await ctx.db
    .query("mentions")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .paginate({ cursor, numItems: CASCADE_BATCH });

  const byEntity = new Map<Id<"entities">, Doc<"mentions">[]>();
  for (const row of page.page) {
    const rows = byEntity.get(row.entityId);
    if (rows) rows.push(row);
    else byEntity.set(row.entityId, [row]);
  }

  const candidates = new Set(orphanCandidates);
  for (const [entityId, rows] of byEntity) {
    const source = await ctx.db.get(entityId);
    // Already a target-project entity: a previous batch created the twin and
    // this row was written against it, or the graph was always over there.
    if (!source || source.projectId === targetProjectId) continue;

    const twinId = await twinEntity(ctx, source, targetProjectId);
    const twin = await ctx.db.get(twinId);
    if (!twin) continue;
    candidates.add(entityId);

    // Asked before the repoint: does the twin already hold a mention in this
    // document from an earlier batch?
    const twinAlreadyHere = await ctx.db
      .query("mentions")
      .withIndex("by_entity", (q) =>
        q.eq("entityId", twinId).eq("documentId", documentId)
      )
      .first();

    for (const row of rows) await ctx.db.patch(row._id, { entityId: twinId });

    // Asked after: does the source still have a mention here, in a page of the
    // index this cursor has not reached yet?
    const sourceStillHere = await ctx.db
      .query("mentions")
      .withIndex("by_entity", (q) =>
        q.eq("entityId", entityId).eq("documentId", documentId)
      )
      .first();

    await ctx.db.patch(entityId, {
      mentionCount: Math.max(0, source.mentionCount - rows.length),
      documentCount: sourceStillHere
        ? source.documentCount
        : Math.max(0, source.documentCount - 1),
    });
    await ctx.db.patch(twinId, {
      mentionCount: twin.mentionCount + rows.length,
      documentCount: twinAlreadyHere
        ? twin.documentCount
        : twin.documentCount + 1,
    });
  }

  return {
    cursor: page.isDone ? null : page.continueCursor,
    orphanCandidates: [...candidates],
  };
}

/**
 * Repoint this document's contextual roles.
 *
 * Roles carry no counts, but they are the reason an entity can exist with no
 * mention at all — the resolver writes one whenever it names an entity, even
 * when no block matched — so they get their own phase and their own twin
 * creation rather than riding on the mention pass.
 *
 * A role the twin already holds for this document is deleted rather than
 * repointed: the pair is what makes it unique, and two identical rows would
 * render the same role twice.
 */
async function moveEntityRoles(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  targetProjectId: Id<"projects">,
  cursor: string | null,
  orphanCandidates: Id<"entities">[]
): Promise<{ cursor: string | null; orphanCandidates: Id<"entities">[] }> {
  const page = await ctx.db
    .query("entityRoles")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .paginate({ cursor, numItems: CASCADE_BATCH });

  const candidates = new Set(orphanCandidates);
  for (const row of page.page) {
    const source = await ctx.db.get(row.entityId);
    if (!source || source.projectId === targetProjectId) continue;

    const twinId = await twinEntity(ctx, source, targetProjectId);
    candidates.add(row.entityId);

    const duplicate = await ctx.db
      .query("entityRoles")
      .withIndex("by_entity_and_document", (q) =>
        q.eq("entityId", twinId).eq("documentId", documentId)
      )
      .filter((q) => q.eq(q.field("role"), row.role))
      .first();
    if (duplicate) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { entityId: twinId });
  }

  return {
    cursor: page.isDone ? null : page.continueCursor,
    orphanCandidates: [...candidates],
  };
}

/**
 * Repoint both ends of the relationships this document asserted.
 *
 * The edge belongs to the document that stated it, so it travels with it. An
 * entity at either end may have no mention and no role in this document at all
 * — it can be the far end of an edge whose evidence sits elsewhere — which is
 * why both ends are twinned here rather than assumed already moved.
 */
async function moveRelationships(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  targetProjectId: Id<"projects">,
  cursor: string | null,
  orphanCandidates: Id<"entities">[]
): Promise<{ cursor: string | null; orphanCandidates: Id<"entities">[] }> {
  const page = await ctx.db
    .query("relationships")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .paginate({ cursor, numItems: CASCADE_BATCH });

  const candidates = new Set(orphanCandidates);
  for (const row of page.page) {
    const patch: {
      sourceEntityId?: Id<"entities">;
      targetEntityId?: Id<"entities">;
    } = {};

    for (const end of ["sourceEntityId", "targetEntityId"] as const) {
      const entity = await ctx.db.get(row[end]);
      if (!entity || entity.projectId === targetProjectId) continue;
      patch[end] = await twinEntity(ctx, entity, targetProjectId);
      candidates.add(row[end]);
    }

    if (patch.sourceEntityId || patch.targetEntityId) {
      await ctx.db.patch(row._id, patch);
    }
  }

  return {
    cursor: page.isDone ? null : page.continueCursor,
    orphanCandidates: [...candidates],
  };
}

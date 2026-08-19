import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CASCADE_BATCH, ORPHAN_BATCH, sweepOrphanEntities } from "./documents";

/**
 * Repair pass for entity data stranded by a deletion cascade that never
 * finished. `drainDeletion` self-reschedules with no retry, so any failure —
 * a deploy that shifted its phase numbering mid-flight, a transient error —
 * silently strands the document's mentions, roles, and the entities they were
 * the last evidence for. Three documents did exactly that in the first week of
 * real use. This sweep is the terminal-state backstop, the same bargain as
 * `sweepStuckJobs`: the cascade is still the fast path, this is the guarantee.
 *
 * Four self-rescheduled phases, each one bounded transaction at a time:
 *   0  walk `mentions`, delete rows whose document is gone, adjust counts
 *   1  walk `entityRoles`, delete rows whose document is gone
 *   2  walk `entities`, feeding each row to the ordinary orphan sweep
 *   3  finish entities the orphan sweep deferred (more edges than one batch)
 *
 * Phase 2 walks the whole table rather than only entities the earlier phases
 * touched because an entity can be orphaned with no dangling row left to name
 * it — two were, by deletions that predate the current cascade entirely.
 *
 * Counts are adjusted arithmetically, mirroring `drainMentions`: subtracting
 * what this batch removed is exact, and recounting a common entity's mentions
 * is the read that used to blow transaction limits.
 */
export const sweep = internalMutation({
  args: {
    phase: v.optional(v.number()),
    cursor: v.optional(v.string()),
    // Entities the orphan sweep could not finish in one transaction.
    orphanCandidates: v.optional(v.array(v.id("entities"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const phase = args.phase ?? 0;
    let orphanCandidates = args.orphanCandidates ?? [];
    let cursor: string | undefined;
    let more = false;

    if (phase === 0) {
      const result = await sweepDanglingMentions(ctx, args.cursor);
      more = result.more;
      cursor = result.cursor;
    } else if (phase === 1) {
      const result = await sweepDanglingRoles(ctx, args.cursor);
      more = result.more;
      cursor = result.cursor;
    } else if (phase === 2) {
      // ORPHAN_BATCH entities per transaction, matching what the orphan sweep
      // will examine, so leftovers can only come from relationship draining.
      const page = await ctx.db
        .query("entities")
        .paginate({ numItems: ORPHAN_BATCH, cursor: args.cursor ?? null });
      orphanCandidates = await sweepOrphanEntities(ctx, [
        ...orphanCandidates,
        ...page.page.map((e) => e._id),
      ]);
      more = !page.isDone;
      cursor = page.continueCursor;
    } else if (phase === 3) {
      orphanCandidates = await sweepOrphanEntities(ctx, orphanCandidates);
      more = orphanCandidates.length > 0;
    } else {
      return null;
    }

    const next = more ? phase : phase + 1;
    if (next > 3 || (next === 3 && orphanCandidates.length === 0)) return null;
    await ctx.scheduler.runAfter(0, internal.entitySweep.sweep, {
      phase: next,
      // The cursor belongs to one table's pagination; a phase change resets it.
      cursor: more ? cursor : undefined,
      orphanCandidates,
    });
    return null;
  },
});

async function documentExists(
  ctx: MutationCtx,
  cache: Map<Id<"documents">, boolean>,
  documentId: Id<"documents">
): Promise<boolean> {
  let exists = cache.get(documentId);
  if (exists === undefined) {
    exists = (await ctx.db.get(documentId)) !== null;
    cache.set(documentId, exists);
  }
  return exists;
}

async function sweepDanglingMentions(
  ctx: MutationCtx,
  cursor: string | undefined
): Promise<{ more: boolean; cursor: string | undefined }> {
  const page = await ctx.db
    .query("mentions")
    .paginate({ numItems: CASCADE_BATCH, cursor: cursor ?? null });

  const docCache = new Map<Id<"documents">, boolean>();
  // Removed rows per (entity, dead document), so counts adjust exactly the
  // way drainMentions adjusts them: mentionCount by what was removed,
  // documentCount once per document the entity no longer appears in.
  const removed = new Map<Id<"entities">, Map<Id<"documents">, number>>();
  for (const row of page.page) {
    if (await documentExists(ctx, docCache, row.documentId)) continue;
    const perDoc = removed.get(row.entityId) ?? new Map();
    perDoc.set(row.documentId, (perDoc.get(row.documentId) ?? 0) + 1);
    removed.set(row.entityId, perDoc);
    await ctx.db.delete(row._id);
  }

  for (const [entityId, perDoc] of removed) {
    const entity = await ctx.db.get(entityId);
    if (!entity) continue;

    let mentionsRemoved = 0;
    let documentsVacated = 0;
    for (const [documentId, count] of perDoc) {
      mentionsRemoved += count;
      const still = await ctx.db
        .query("mentions")
        .withIndex("by_entity", (q) =>
          q.eq("entityId", entityId).eq("documentId", documentId)
        )
        .first();
      if (!still) documentsVacated += 1;
    }

    await ctx.db.patch(entityId, {
      mentionCount: Math.max(0, entity.mentionCount - mentionsRemoved),
      documentCount: Math.max(0, entity.documentCount - documentsVacated),
    });
  }

  return { more: !page.isDone, cursor: page.continueCursor };
}

async function sweepDanglingRoles(
  ctx: MutationCtx,
  cursor: string | undefined
): Promise<{ more: boolean; cursor: string | undefined }> {
  const page = await ctx.db
    .query("entityRoles")
    .paginate({ numItems: CASCADE_BATCH, cursor: cursor ?? null });

  const docCache = new Map<Id<"documents">, boolean>();
  for (const row of page.page) {
    if (await documentExists(ctx, docCache, row.documentId)) continue;
    await ctx.db.delete(row._id);
  }

  return { more: !page.isDone, cursor: page.continueCursor };
}

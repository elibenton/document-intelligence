import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { processingPool } from "./processingPool";

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const active = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect();

    // Analyze is the one stage with no state of its own on the document: the
    // row sits at "parsed" from the moment the scan lands until extraction
    // starts, so "is Analyze running, or did it fail?" is only answerable from
    // its job row. The library labels rows with that answer, so it rides along
    // here — one indexed read, and only for the rows actually in that gap,
    // rather than a subscription per visible row.
    return await Promise.all(
      active.map(async (doc) => {
        if (doc.status !== "parsed") return { ...doc, analyzeStatus: null };
        const job = await ctx.db
          .query("processingJobs")
          .withIndex("by_document", (q) =>
            q.eq("documentId", doc._id).eq("stage", "analyze")
          )
          .first();
        return { ...doc, analyzeStatus: job?.status ?? null };
      })
    );
  },
});

/**
 * Account-level blockers affecting document processing, for the global
 * banner. Running out of API credits stops every upload from progressing, so
 * it can't be reported only as red text on whichever document happened to be
 * running — the user needs to see the cause and the fix wherever they are.
 *
 * Scans by status index (failed documents only) and reports the most recent
 * blocking failure plus how many documents are stuck behind it.
 */
export const processingBlocker = query({
  args: {},
  handler: async (ctx) => {
    const failed = await ctx.db
      .query("documents")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .collect();

    const blocked = failed.filter(
      (d) =>
        d.errorCode === "insufficient_credits" ||
        d.errorCode === "invalid_api_key"
    );
    if (blocked.length === 0) return null;

    // Newest failure wins: if the key was replaced after a credit outage, the
    // banner should describe the condition the user is actually in now.
    const latest = blocked.reduce((a, b) => (b.uploadedAt > a.uploadedAt ? b : a));
    return {
      code: latest.errorCode as "insufficient_credits" | "invalid_api_key",
      message: latest.errorMessage ?? "Document processing is blocked.",
      affectedCount: blocked.length,
    };
  },
});

/**
 * The document row plus its signed file URL.
 *
 * The URL rides along because the viewer needs both and used to fetch them in
 * series — `getUrl` could not run until `get` had returned a storageId, so the
 * whole time-to-first-pixel was gated on two sequential round trips.
 */
export const get = query({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);
    if (!document) return null;
    return { ...document, url: await ctx.storage.getUrl(document.storageId) };
  },
});

/**
 * Pipeline status for the handful of documents the progress overlay is still
 * holding. The overlay keeps a card until the work it is watching reaches a
 * terminal state, so it needs the stage of a few known ids — not a
 * subscription per library row.
 *
 * `analyzeStatus` rides along because Analyze is the one stage with no state of
 * its own on the document: a re-analyzed document sits at "parsed"/"completed"
 * from start to finish, so `status` alone can never say the pass is running or
 * done. Same indexed read `list` already makes for the library's analyze label.
 *
 * A deleted document reports "missing" so the overlay releases the card
 * instead of holding it forever.
 */
export const ingestStates = query({
  args: { ids: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    return await Promise.all(
      args.ids.map(async (id) => {
        const doc = await ctx.db.get(id);
        const job = doc
          ? await ctx.db
              .query("processingJobs")
              .withIndex("by_document", (q) =>
                q.eq("documentId", id).eq("stage", "analyze")
              )
              .first()
          : null;
        return {
          _id: id,
          status: doc?.status ?? "missing",
          analyzeStatus: job?.status ?? null,
          errorMessage: doc?.errorMessage ?? job?.errorMessage,
        };
      })
    );
  },
});

/** Rotate every page while preserving any page-specific adjustment. */
export const rotateDocument = mutation({
  args: {
    id: v.id("documents"),
    degrees: v.union(v.literal(90), v.literal(-90)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);
    if (!document) return null;
    const next = ((document.viewerRotation ?? 0) + args.degrees + 360) % 360;
    await ctx.db.patch(args.id, {
      viewerRotation: next as 0 | 90 | 180 | 270,
    });
    return null;
  },
});

/** Cap on kinds per document — a document that is eight things is untagged. */
const MAX_KINDS = 8;

/**
 * Human edits to a document's identity: the title shown in the UI and the
 * semantic kinds it belongs to (see the identity menu on the left of every
 * document name).
 *
 * Both fields are optional and independent — the menu sends only what
 * changed. An empty `displayName` clears the human title and the "human"
 * stamp with it, which puts the document back in reach of the AI rename pass.
 */
export const updateIdentity = mutation({
  args: {
    id: v.id("documents"),
    displayName: v.optional(v.string()),
    kinds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return;

    const patch: {
      displayName?: string;
      displayNameSource?: string;
      kinds?: string[];
      primaryKind?: string;
      kindSource?: string;
    } = {};

    if (args.displayName !== undefined) {
      const title = args.displayName.trim();
      // A title equal to the filename is the same as having none: the UI
      // would print the same string twice, once per line.
      const keep = title && title !== doc.name;
      patch.displayName = keep ? title : undefined;
      patch.displayNameSource = keep ? "human" : undefined;
    }

    if (args.kinds !== undefined) {
      const kinds = [
        ...new Set(
          args.kinds.map((k) => k.trim().toLowerCase()).filter(Boolean)
        ),
      ].slice(0, MAX_KINDS);
      patch.kinds = kinds;
      // Keep the legacy single field in step — the extraction template and
      // the pipeline progress bar both read it.
      patch.primaryKind = kinds[0];
      patch.kindSource = "human";

      // Register anything new so it becomes a pill for every other document.
      for (const name of kinds) {
        await ctx.runMutation(internal.kinds.upsert, {
          name,
          source: "human",
        });
      }
    }

    await ctx.db.patch(args.id, patch);
  },
});

/**
 * Add kinds to a document without disturbing the ones it already has.
 *
 * `updateIdentity` replaces the whole set, which is right for the identity
 * editor but wrong for tagging a selection: the documents in a selection rarely
 * share a kind list, and replacing would flatten them all to the same one.
 */
export const addKinds = mutation({
  args: { id: v.id("documents"), kinds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return;

    const existing = doc.kinds ?? (doc.primaryKind ? [doc.primaryKind] : []);
    const added = args.kinds
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    const kinds = [...new Set([...existing, ...added])].slice(0, MAX_KINDS);

    await ctx.db.patch(args.id, {
      kinds,
      primaryKind: kinds[0],
      kindSource: "human",
    });

    for (const name of added) {
      await ctx.runMutation(internal.kinds.upsert, {
        name,
        source: "human",
      });
    }
  },
});

export const getUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

/**
 * Tables holding rows that exist only because a document does, each reachable
 * by a `by_document` index whose first field is `documentId`. Drained in this
 * order; nothing here depends on the order, it is just the order they are read.
 *
 * `mentions` and `mergeSuggestions` are absent on purpose — both need more than
 * a delete (entity bookkeeping, preserved merge history) and get their own
 * phases below.
 */
const DOCUMENT_SCOPED_TABLES = [
  "blocks",
  "pages",
  "pageTranslations",
  "transcriptSegments",
  "extractions",
  "detections",
  "annotations",
  "research",
  "processingJobs",
  "relationships",
  "entityRoles",
] as const;

type DocumentScopedTable = (typeof DOCUMENT_SCOPED_TABLES)[number];

/**
 * Rows deleted per transaction. Deliberately small: `blocks` rows carry a
 * per-word array and are by far the largest, and a batch that fits the worst
 * table fits all of them. The cascade's cost is transactions, not rows, and a
 * transaction that never approaches its limits never fails.
 */
const CASCADE_BATCH = 128;

/** Orphan candidates examined per transaction — each costs a few index reads. */
const ORPHAN_BATCH = 8;

/**
 * Delete one batch from a document-scoped table.
 * Returns true when the table may still hold more rows for this document.
 */
async function drainTable(
  ctx: MutationCtx,
  table: DocumentScopedTable,
  documentId: Id<"documents">
): Promise<boolean> {
  // Every table in the list has a `by_document` index whose first field is
  // `documentId`, but TypeScript resolves `ctx.db.query` against a union of
  // table names to no common signature. The cast names one member so the
  // builder types resolve; the tables are interchangeable in the only two
  // respects this function uses.
  const rows = await ctx.db
    .query(table as "pages")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(CASCADE_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length === CASCADE_BATCH;
}

/**
 * The part of deleting a document that must happen at once: stop the work that
 * is still costing money, free the stored files, remove the row, and hand the
 * derived rows to `drainDeletion`, which drains one bounded batch per
 * transaction until nothing is left.
 *
 * The cascade cannot run inline. A large document's derived rows run to five
 * figures, and a Convex mutation that exceeds its transaction limits rolls back
 * *entirely* — so the single-transaction version did not leave orphans, it left
 * a document that could never be deleted, failing identically on every retry.
 * Batching trades atomicity for termination, which is the right trade when the
 * end state is "all of it is gone" either way.
 *
 * The document row goes first, in this transaction. That is what makes the rest
 * safe to do later: every ingest mutation ends by patching the document, and
 * `ctx.db.patch` on a missing id throws, so in-flight work rolls itself back
 * instead of writing rows against a document that is being deleted.
 *
 * A plain function rather than a mutation because deleting a project does
 * exactly this to every document it holds, a few per transaction.
 */
export async function beginDocumentTeardown(
  ctx: MutationCtx,
  documentId: Id<"documents">
): Promise<void> {
  const doc = await ctx.db.get(documentId);
  if (!doc) return;

  // Cancel queued work before the job rows that hold its handles are gone.
  // Cancellation is cooperative — a stage already running is allowed to
  // finish — but a queued stage that never starts is a whole Interfaze call
  // not spent on a document nobody will ever see. "enqueuing" is the
  // placeholder written before the pool returns a real id.
  const jobs = await ctx.db
    .query("processingJobs")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  for (const job of jobs) {
    if (!job.workId || job.workId === "enqueuing") continue;
    await processingPool.cancel(
      ctx,
      job.workId as Parameters<typeof processingPool.cancel>[1]
    );
  }

  // Delete the stored file(s) — web clips also carry a markdown article file.
  // Tolerate an already-missing file: throwing here would roll the whole
  // mutation back and leave the document permanently undeletable.
  for (const storageId of [doc.storageId, doc.textStorageId]) {
    if (!storageId) continue;
    try {
      await ctx.storage.delete(storageId);
    } catch {
      // already deleted
    }
  }

  await ctx.db.delete(documentId);
  await ctx.scheduler.runAfter(0, internal.documents.drainDeletion, {
    documentId,
    phase: 0,
    orphanCandidates: [],
  });
}

export const remove = mutation({
  args: { id: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await beginDocumentTeardown(ctx, args.id);
    return null;
  },
});

/**
 * One bounded step of a document's cascade, rescheduling itself until done.
 *
 * `phase` indexes DOCUMENT_SCOPED_TABLES, then the three phases that need more
 * than a delete. State rides in the arguments rather than a tracking table:
 * the only thing that has to survive between transactions is the list of
 * entities this document might have orphaned, and that is bounded by the
 * document's own distinct entities.
 */
export const drainDeletion = internalMutation({
  args: {
    documentId: v.id("documents"),
    phase: v.number(),
    orphanCandidates: v.array(v.id("entities")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { documentId, phase } = args;
    let orphanCandidates = args.orphanCandidates;
    let more = false;

    if (phase < DOCUMENT_SCOPED_TABLES.length) {
      more = await drainTable(ctx, DOCUMENT_SCOPED_TABLES[phase], documentId);
    } else if (phase === DOCUMENT_SCOPED_TABLES.length) {
      more = await drainMergeSuggestions(ctx, documentId);
    } else if (phase === DOCUMENT_SCOPED_TABLES.length + 1) {
      const result = await drainMentions(ctx, documentId, orphanCandidates);
      more = result.more;
      orphanCandidates = result.orphanCandidates;
    } else if (phase === DOCUMENT_SCOPED_TABLES.length + 2) {
      orphanCandidates = await sweepOrphanEntities(ctx, orphanCandidates);
      more = orphanCandidates.length > 0;
    } else {
      return null;
    }

    const next = more ? phase : phase + 1;
    if (next > DOCUMENT_SCOPED_TABLES.length + 2) return null;
    await ctx.scheduler.runAfter(0, internal.documents.drainDeletion, {
      documentId,
      phase: next,
      orphanCandidates,
    });
    return null;
  },
});

/**
 * Merge suggestions raised by this document.
 *
 * Only `pending` rows are the document's to delete. An `accepted` row is the
 * sole surviving record that two entities were merged, and a `rejected` row is
 * what stops the pair being suggested again — `suggestionExists` matches on
 * status-agnostic identity, so deleting a rejection re-arms a suggestion the
 * user has already answered. Both are judgements about a *pair of entities*
 * that happened to be stored against the document where they surfaced, so they
 * outlive it: the provenance link is cleared and the row stays.
 */
async function drainMergeSuggestions(
  ctx: MutationCtx,
  documentId: Id<"documents">
): Promise<boolean> {
  const rows = await ctx.db
    .query("mergeSuggestions")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(CASCADE_BATCH);
  for (const row of rows) {
    if (row.status === "pending") await ctx.db.delete(row._id);
    // Clearing documentId also drops the row out of this index, so the next
    // batch cannot return it again.
    else await ctx.db.patch(row._id, { documentId: undefined });
  }
  return rows.length === CASCADE_BATCH;
}

/**
 * This document's mentions, plus the entity bookkeeping they force.
 *
 * Counts are adjusted arithmetically rather than recounted. The previous
 * version re-read every remaining mention of every affected entity, which for a
 * common entity in a large project is thousands of rows — per entity, and the
 * single largest reason a delete could not fit in one transaction. Subtracting
 * what this batch actually removed is exact for `mentionCount`, and
 * `documentCount` is decremented once, on the batch that takes the entity's
 * last mention in this document.
 *
 * Whether an entity is now orphaned is decided later, in one place, once every
 * mention is gone.
 */
async function drainMentions(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  orphanCandidates: Id<"entities">[]
): Promise<{ more: boolean; orphanCandidates: Id<"entities">[] }> {
  const rows = await ctx.db
    .query("mentions")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(CASCADE_BATCH);

  const removedPerEntity = new Map<Id<"entities">, number>();
  for (const row of rows) {
    removedPerEntity.set(
      row.entityId,
      (removedPerEntity.get(row.entityId) ?? 0) + 1
    );
    await ctx.db.delete(row._id);
  }

  const candidates = new Set(orphanCandidates);
  for (const [entityId, removed] of removedPerEntity) {
    const entity = await ctx.db.get(entityId);
    if (!entity) continue;
    candidates.add(entityId);

    // Exact two-field lookup: does this entity still have a mention *here*?
    const stillInThisDocument = await ctx.db
      .query("mentions")
      .withIndex("by_entity", (q) =>
        q.eq("entityId", entityId).eq("documentId", documentId)
      )
      .first();

    await ctx.db.patch(entityId, {
      mentionCount: Math.max(0, entity.mentionCount - removed),
      documentCount: stillInThisDocument
        ? entity.documentCount
        : Math.max(0, entity.documentCount - 1),
    });
  }

  return {
    more: rows.length === CASCADE_BATCH,
    orphanCandidates: [...candidates],
  };
}

/**
 * Delete entities this document was the last evidence for.
 *
 * An entity is orphaned only when nothing points at it any more: no mention,
 * and no role on any *other* document. Roles are the case the mention-only test
 * missed — they are written whenever the resolver names an entity, including
 * when no block matched and so no mention exists, and a human can add one by
 * hand. Deleting on the mention test alone left those rows pointing at nothing,
 * and the document that held them quietly lost a role.
 *
 * `starred` is a human saying this entity matters. It survives its evidence.
 *
 * Relationships must go with the entity — they carry `v.id("entities")` at both
 * ends and Convex enforces no referential integrity, so leaving them is leaving
 * a dangling id. They are drained a batch at a time; an entity with more edges
 * than one batch stays a candidate and is finished on a later pass.
 */
async function sweepOrphanEntities(
  ctx: MutationCtx,
  candidates: Id<"entities">[]
): Promise<Id<"entities">[]> {
  const remaining = candidates.slice(ORPHAN_BATCH);

  for (const entityId of candidates.slice(0, ORPHAN_BATCH)) {
    const entity = await ctx.db.get(entityId);
    if (!entity || entity.starred === true) continue;

    const anyMention = await ctx.db
      .query("mentions")
      .withIndex("by_entity", (q) => q.eq("entityId", entityId))
      .first();
    if (anyMention) continue;

    const anyRole = await ctx.db
      .query("entityRoles")
      .withIndex("by_entity", (q) => q.eq("entityId", entityId))
      .first();
    if (anyRole) continue;

    const sourceRels = await ctx.db
      .query("relationships")
      .withIndex("by_source", (q) => q.eq("sourceEntityId", entityId))
      .take(CASCADE_BATCH);
    for (const rel of sourceRels) await ctx.db.delete(rel._id);

    const targetRels = await ctx.db
      .query("relationships")
      .withIndex("by_target", (q) => q.eq("targetEntityId", entityId))
      .take(CASCADE_BATCH);
    for (const rel of targetRels) await ctx.db.delete(rel._id);

    if (
      sourceRels.length === CASCADE_BATCH ||
      targetRels.length === CASCADE_BATCH
    ) {
      remaining.push(entityId);
      continue;
    }

    // Suggestions naming an entity that no longer exists can never be shown
    // or matched again, so unlike the document-scoped sweep above there is no
    // judgement here worth preserving.
    const asSource = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_source_and_target", (q) => q.eq("sourceEntityId", entityId))
      .collect();
    for (const s of asSource) await ctx.db.delete(s._id);

    const asTarget = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_target", (q) => q.eq("targetEntityId", entityId))
      .collect();
    for (const s of asTarget) await ctx.db.delete(s._id);

    await ctx.db.delete(entityId);
  }

  return remaining;
}


import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./authz";
import { recordOverride } from "./apiLogs";
import { MAX_PLACE_LENGTH, sanitizeDocumentDate } from "./metadata";
import {
  filterOwnedDocuments,
  keepOwned,
  requireDocument,
  requireProject,
} from "./ownership";

export const list = authedQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
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
        // How many highlights/comments the document carries, for the Library's
        // Notes column. Counted per document off `by_document` rather than a
        // new by_project index because rows from before projectId was
        // denormalized would be invisible to a project-scoped read.
        const noteCount = (
          await ctx.db
            .query("annotations")
            .withIndex("by_document", (q) => q.eq("documentId", doc._id))
            .collect()
        ).length;
        if (doc.status !== "parsed") {
          return { ...doc, analyzeStatus: null, noteCount };
        }
        const job = await ctx.db
          .query("processingJobs")
          .withIndex("by_document", (q) =>
            q.eq("documentId", doc._id).eq("stage", "analyze")
          )
          .first();
        return { ...doc, analyzeStatus: job?.status ?? null, noteCount };
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
export const processingBlocker = authedQuery({
  args: {},
  handler: async (ctx) => {
    // `by_status` spans the deployment, so the result is narrowed to the
    // caller's projects before it is counted — otherwise the banner reports a
    // stranger's credit outage, and `affectedCount` counts their documents.
    const failed = await keepOwned(
      ctx,
      await ctx.db
        .query("documents")
        .withIndex("by_status", (q) => q.eq("status", "failed"))
        .collect()
    );

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
 * series — a separate `getUrl` could not run until `get` had returned a
 * storageId, so the whole time-to-first-pixel was gated on two sequential round
 * trips. That endpoint is gone: it took a bare `v.id("_storage")`, which is not
 * a row anyone owns and so cannot be ownership-checked, and nothing had called
 * it since this merge.
 */
async function withUrl(ctx: QueryCtx, document: Doc<"documents">) {
  return { ...document, url: await ctx.storage.getUrl(document.storageId) };
}

/**
 * Shared by the public `get` and the pipeline's `getInternal` below, so the two
 * cannot drift.
 */
async function readDocument(ctx: QueryCtx, id: Id<"documents">) {
  const document = await ctx.db.get(id);
  if (!document) return null;
  return await withUrl(ctx, document);
}

export const get = authedQuery({
  // requireDocument returns the row, so this is the same single read `get`
  // always made — the ownership walk costs the project row, nothing more.
  args: { id: v.id("documents") },
  handler: async (ctx, args) => withUrl(ctx, await requireDocument(ctx, args.id)),
});

/**
 * The same read, for the processing pipeline.
 *
 * The pipeline actions run from the scheduler, and Convex does not propagate
 * identity through the scheduler — so they cannot call the authenticated `get`.
 * They are already unreachable from outside, which is what makes an unguarded
 * read safe here.
 */
export const getInternal = internalQuery({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => readDocument(ctx, args.id),
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
/**
 * Just enough of a document to cite it: what Analyze read off the page, plus
 * the three facts the app already knows and therefore never asked the model
 * for — the library title, the document's own date, and where a web clip came
 * from. Merged into CSL-JSON by src/lib/citation/cslItem.ts.
 *
 * Batched over the answer's cited documents rather than one subscription per
 * evidence card, and deliberately narrow: the full rows carry page text and
 * table-of-contents data a bibliography has no use for.
 */
export const citationSources = authedQuery({
  args: { ids: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    const rows = await filterOwnedDocuments(ctx, args.ids);
    return rows.map((doc) => ({
      _id: doc._id,
      name: doc.name,
      displayName: doc.displayName,
      // Doubles as CSL `genre` for a document with no bibliographic type of
      // its own — see cslItem.ts.
      primaryKind: doc.primaryKind,
      documentDate: doc.documentDate,
      documentDatePrecision: doc.documentDatePrecision,
      sourceUrl: doc.sourceUrl,
      uploadedAt: doc.uploadedAt,
      citation: doc.citation,
    }));
  },
});

/**
 * Signed file URLs for a set of documents — what the evidence carousel needs to
 * draw its pages client-side with pdf.js (see SinglePagePreview). Batched over
 * the answer's cited documents like `citationSources`, and just as narrow: the
 * page renderer has no use for the rest of the row. `mediaType` rides along so
 * the client knows whether the file is drawable at all.
 */
export const fileUrls = authedQuery({
  args: { ids: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    const rows = await filterOwnedDocuments(ctx, args.ids);
    return await Promise.all(
      rows.map(async (doc) => ({
        _id: doc._id,
        url: await ctx.storage.getUrl(doc.storageId),
        mediaType: doc.mediaType,
      }))
    );
  },
});

export const ingestStates = authedQuery({
  args: { ids: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    // A document the caller does not own reads as "missing", which is the same
    // answer a deleted one gives — so the overlay releases its card either way,
    // and the endpoint never confirms that someone else's id exists.
    const owned = new Map(
      (await filterOwnedDocuments(ctx, args.ids)).map((doc) => [doc._id, doc])
    );
    return await Promise.all(
      args.ids.map(async (id) => {
        const doc = owned.get(id);
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
export const rotateDocument = authedMutation({
  args: {
    id: v.id("documents"),
    degrees: v.union(v.literal(90), v.literal(-90)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await requireDocument(ctx, args.id);
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
 * Both fields are optional and independent — the editors send only what
 * changed. An empty `displayName` is a tombstone like setField's: the library
 * falls back to showing `name`, and the "human" stamp keeps the rename pass
 * from re-titling what a person deleted. `resetDisplayName` re-opens the
 * field to automation instead.
 */
export const updateIdentity = authedMutation({
  args: {
    id: v.id("documents"),
    displayName: v.optional(v.string()),
    kinds: v.optional(v.array(v.string())),
    resetDisplayName: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const doc = await requireDocument(ctx, args.id);

    // A commit that displaces an AI-written value is a rejection worth
    // measuring; authoring into an empty field is not. Absent source with a
    // value present counts as AI — rows from before the stamps existed.
    if (
      args.displayName !== undefined &&
      doc.displayName &&
      doc.displayNameSource !== "human" &&
      args.displayName.trim() !== doc.displayName
    ) {
      await recordOverride(ctx, { documentId: args.id, field: "displayName" });
    }
    if (
      args.kinds !== undefined &&
      (doc.kinds?.length ?? 0) > 0 &&
      doc.kindSource !== "human"
    ) {
      await recordOverride(ctx, { documentId: args.id, field: "kind" });
    }

    const patch: {
      displayName?: string;
      displayNameSource?: string;
      kinds?: string[];
      primaryKind?: string;
      kindSource?: string;
    } = {};

    if (args.resetDisplayName) {
      patch.displayName = undefined;
      patch.displayNameSource = undefined;
    } else if (args.displayName !== undefined) {
      const title = args.displayName.trim();
      // A title equal to the filename is the same as having none: the UI
      // would print the same string twice, once per line.
      const keep = title && title !== doc.name;
      patch.displayName = keep ? title : undefined;
      // Always "human": a kept title is authored, and an emptied (or
      // filename-restating) one is a tombstone — the person chose the
      // filename, so the rename pass must not re-title it (rename.ts
      // TITLE_RANK). resetDisplayName above is the re-open affordance.
      patch.displayNameSource = "human";
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
      // Same rule as the title above: a committed value stamps "human", an
      // emptied one clears the stamp and re-opens the field to Analyze.
      patch.kindSource = kinds.length > 0 ? "human" : undefined;

      // Register anything new so it becomes a pill for every other document
      // in the same project.
      if (doc.projectId) {
        for (const name of kinds) {
          await ctx.runMutation(internal.kinds.upsert, {
            projectId: doc.projectId,
            name,
            source: "human",
          });
        }
      }
    }

    await ctx.db.patch(args.id, patch);
  },
});


/**
 * Add kinds to a document without disturbing the ones it already has —
 * replacing would be wrong for tagging a selection: the documents in a
 * selection rarely share a kind list, and replacing would flatten them all to
 * the same one.
 */
/**
 * Human edit of one scalar Analyze field, for the inline editors. One
 * mutation with a closed field union rather than four micro-mutations: the
 * provenance rule, the override recording, and the ownership walk are the
 * same for all of them, and only the validation differs.
 *
 * The rule (documented on the schema's *Source fields): a non-empty commit
 * stamps `"human"` and automation skips the field; an EMPTY commit is a
 * deliberate deletion — the value goes and the stamp stays `"human"` (a
 * tombstone), so neither Analyze nor a native ingest refills what a person
 * edited out. `reset: true` is the separate re-open affordance: it clears
 * value and stamp both, handing the field back to automation. Clearing still
 * records the override, so the rejection isn't lost with the value.
 */
export const setField = authedMutation({
  args: {
    id: v.id("documents"),
    field: v.union(
      v.literal("primaryCategory"),
      v.literal("documentDate"),
      v.literal("createdDate"),
      v.literal("documentPlace"),
      v.literal("author"),
      v.literal("sourceLanguageCode")
    ),
    value: v.optional(v.string()),
    /** Dates only: "day" | "month" | "year". Inferred client-side
     *  from the value's shape; validated here against it. */
    precision: v.optional(v.string()),
    /** Re-open the field to automation: clears value AND stamp. The value
     *  arg is ignored. Distinct from an empty commit, which tombstones. */
    reset: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const doc = await requireDocument(ctx, args.id);
    const value = args.reset ? "" : (args.value ?? "").trim();

    const sourceField = (
      {
        primaryCategory: "primaryCategorySource",
        documentDate: "documentDateSource",
        createdDate: "createdDateSource",
        documentPlace: "documentPlaceSource",
        author: "authorSource",
        sourceLanguageCode: "sourceLanguageSource",
      } as const
    )[args.field];

    // A reset is an un-decision, not a rejection — nothing to record.
    if (!args.reset && doc[args.field] && doc[sourceField] !== "human") {
      await recordOverride(ctx, { documentId: args.id, field: args.field });
    }

    const stamp = value ? "human" : args.reset ? undefined : "human";
    // Every empty-value patch below writes { value: undefined, source: stamp }:
    // a tombstone on an ordinary clear, a full re-open on reset.

    switch (args.field) {
      case "primaryCategory": {
        if (value) {
          const key = value.toLowerCase();
          const projectId = doc.projectId;
          const known =
            projectId !== undefined &&
            (await ctx.db
              .query("documentCategories")
              .withIndex("by_project_and_key", (q) =>
                q.eq("projectId", projectId).eq("key", key)
              )
              .first()) !== null;
          if (!known) throw new Error(`Not a category in this project: ${key}`);
          await ctx.db.patch(args.id, {
            primaryCategory: key,
            primaryCategorySource: stamp,
          });
        } else {
          await ctx.db.patch(args.id, {
            primaryCategory: undefined,
            primaryCategorySource: stamp,
          });
        }
        return;
      }
      case "documentDate":
      case "createdDate": {
        const valueField = args.field;
        const precisionField =
          args.field === "documentDate"
            ? "documentDatePrecision"
            : "createdDatePrecision";
        if (value) {
          // Same shape/impossible-date validation Analyze output gets, minus
          // the future-date rejection: that guard exists for hallucinations,
          // and a human typing a date is asserting a fact.
          const sanitized = sanitizeDocumentDate(
            { value, precision: args.precision },
            Infinity
          );
          if (!sanitized) {
            throw new Error(
              "Not a valid date: use YYYY, YYYY-MM, or YYYY-MM-DD"
            );
          }
          await ctx.db.patch(args.id, {
            [valueField]: sanitized.documentDate,
            [precisionField]: sanitized.documentDatePrecision,
            [sourceField]: "human",
          });
        } else {
          await ctx.db.patch(args.id, {
            [valueField]: undefined,
            [precisionField]: undefined,
            [sourceField]: stamp,
          });
        }
        return;
      }
      case "documentPlace": {
        const place = value.replace(/\s+/g, " ").slice(0, MAX_PLACE_LENGTH);
        // No NOT_A_PLACE screen here: that regex catches the model writing
        // "unknown" into a field it should have left empty; a human typing
        // it means it. Evidence is cleared either way — a quote supporting a
        // value that no longer exists is stale.
        await ctx.db.patch(args.id, {
          documentPlace: place || undefined,
          documentPlaceEvidence: undefined,
          documentPlaceSource: place ? "human" : stamp,
        });
        return;
      }
      case "author": {
        const author = value.replace(/\s+/g, " ").slice(0, 120);
        await ctx.db.patch(args.id, {
          author: author || undefined,
          authorSource: author ? "human" : stamp,
        });
        return;
      }
      case "sourceLanguageCode": {
        const code = value.toLowerCase().replaceAll("_", "-");
        if (code && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code)) {
          throw new Error(`Not a BCP-47 language code: ${code}`);
        }
        await ctx.db.patch(args.id, {
          sourceLanguageCode: code || undefined,
          sourceLanguageSource: code ? "human" : stamp,
        });
        return;
      }
    }
  },
});

export const addKinds = authedMutation({
  args: { id: v.id("documents"), kinds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const doc = await requireDocument(ctx, args.id);

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

    if (doc.projectId) {
      for (const name of added) {
        await ctx.runMutation(internal.kinds.upsert, {
          projectId: doc.projectId,
          name,
          source: "human",
        });
      }
    }
  },
});

/**
 * Tables holding rows that exist only because a document does, each reachable
 * by a `by_document` index whose first field is `documentId`. Drained in this
 * order; nothing here depends on the order, it is just the order they are read.
 *
 * `mentions` and `mergeSuggestions` are absent on purpose — both need more than
 * a delete (entity bookkeeping, preserved merge history) and get their own
 * phases below. `entityRoles` stays in the list to keep phase numbering stable
 * but is drained by `drainEntityRoles`, which records orphan candidates.
 */
const DOCUMENT_SCOPED_TABLES = [
  "blocks",
  "pages",
  "pageTranslations",
  "transcriptSegments",
  "detections",
  "annotations",
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
export const CASCADE_BATCH = 128;

/** Orphan candidates examined per transaction — each costs a few index reads. */
export const ORPHAN_BATCH = 8;

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
  // placeholder written before the enqueue records a real id.
  const jobs = await ctx.db
    .query("processingJobs")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  for (const job of jobs) {
    if (!job.workId || job.workId === "enqueuing") continue;
    try {
      await ctx.scheduler.cancel(job.workId as Id<"_scheduled_functions">);
    } catch {
      // Pre-scheduler rows can carry an id the scheduler cannot parse.
    }
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
  // The cascade needs the project after the row is gone: the searches and
  // mergeLog phases can only find their rows through a by_project index.
  await ctx.scheduler.runAfter(0, internal.documents.drainDeletion, {
    documentId,
    projectId: doc.projectId,
    phase: 0,
    orphanCandidates: [],
  });
}

export const remove = authedMutation({
  args: { id: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.id);
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
    // Optional twice over: pre-project documents have none, and cascades
    // scheduled before this argument existed arrive without it. Either way the
    // searches and mergeLog phases are skipped — they can only reach their
    // rows through a project index.
    projectId: v.optional(v.id("projects")),
    phase: v.number(),
    orphanCandidates: v.array(v.id("entities")),
    // Pagination state for the searches phase, opaque to everything else.
    searchCursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { documentId, phase } = args;
    let orphanCandidates = args.orphanCandidates;
    let searchCursor: string | undefined;
    let more = false;

    if (phase < DOCUMENT_SCOPED_TABLES.length) {
      const table = DOCUMENT_SCOPED_TABLES[phase];
      if (table === "entityRoles") {
        const result = await drainEntityRoles(ctx, documentId, orphanCandidates);
        more = result.more;
        orphanCandidates = result.orphanCandidates;
      } else {
        more = await drainTable(ctx, table, documentId);
      }
    } else if (phase === DOCUMENT_SCOPED_TABLES.length) {
      more = await drainMergeSuggestions(ctx, documentId);
    } else if (phase === DOCUMENT_SCOPED_TABLES.length + 1) {
      const result = await drainMentions(ctx, documentId, orphanCandidates);
      more = result.more;
      orphanCandidates = result.orphanCandidates;
    } else if (phase === DOCUMENT_SCOPED_TABLES.length + 2) {
      orphanCandidates = await sweepOrphanEntities(ctx, orphanCandidates);
      more = orphanCandidates.length > 0;
    } else if (phase === DOCUMENT_SCOPED_TABLES.length + 3) {
      if (args.projectId) {
        const result = await drainDocumentSearches(
          ctx,
          args.projectId,
          documentId,
          args.searchCursor
        );
        more = result.more;
        searchCursor = result.cursor;
      }
    } else if (phase === DOCUMENT_SCOPED_TABLES.length + 4) {
      if (args.projectId) {
        await scrubMergeLogQuotes(ctx, args.projectId, documentId);
      }
    } else {
      return null;
    }

    const next = more ? phase : phase + 1;
    if (next > DOCUMENT_SCOPED_TABLES.length + 4) return null;
    await ctx.scheduler.runAfter(0, internal.documents.drainDeletion, {
      documentId,
      projectId: args.projectId,
      phase: next,
      orphanCandidates,
      searchCursor,
    });
    return null;
  },
});

/**
 * Delete the project's search rows that cite this document.
 *
 * The whole row, not a scrubbed entry: `answer` is a synthesis that quotes the
 * snippets, so a search whose cited document is gone cannot be surgically
 * cleaned — and its evidence chain is broken anyway. A search citing several
 * documents disappears when any one of them is deleted; that is the price of
 * "deleting a document deletes what was derived from it".
 *
 * Paginated rather than cursor-by-createdAt because search rows accumulate one
 * per query, unboundedly; the opaque cursor rides in drainDeletion's args.
 */
const SEARCH_SCAN_BATCH = 64;

async function drainDocumentSearches(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  documentId: Id<"documents">,
  cursor: string | undefined
): Promise<{ more: boolean; cursor: string | undefined }> {
  const page = await ctx.db
    .query("searches")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .paginate({ numItems: SEARCH_SCAN_BATCH, cursor: cursor ?? null });
  for (const row of page.page) {
    if (row.results?.some((r) => r.documentId === documentId)) {
      await ctx.db.delete(row._id);
    }
  }
  return { more: !page.isDone, cursor: page.continueCursor };
}

/**
 * Strip this document's verbatim quotes out of the project's merge history.
 *
 * The entry itself stays — it is what unmerge restores, and the relationship
 * shape (type, direction, confidence) is the merge's own record — but the
 * quote is the document's text and must not outlive it. One pass, not batched:
 * mergeLog rows exist one per human merge action, which bounds them the way
 * nothing bounds searches.
 */
async function scrubMergeLogQuotes(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  documentId: Id<"documents">
): Promise<void> {
  const rows = await ctx.db
    .query("mergeLog")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  for (const row of rows) {
    if (!row.deletedRelationships.some((r) => r.documentId === documentId)) {
      continue;
    }
    await ctx.db.patch(row._id, {
      deletedRelationships: row.deletedRelationships.map((r) =>
        r.documentId === documentId ? { ...r, quote: undefined } : r
      ),
    });
  }
}

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
 * This document's role rows, with the entities they name recorded as orphan
 * candidates. A role is the other edge that keeps an entity alive — the sweep
 * checks both — so an entity whose only evidence was a role here must be
 * examined too. Draining this table blindly left exactly those entities
 * stranded, mentionless and roleless, in the library forever.
 */
async function drainEntityRoles(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  orphanCandidates: Id<"entities">[]
): Promise<{ more: boolean; orphanCandidates: Id<"entities">[] }> {
  const rows = await ctx.db
    .query("entityRoles")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(CASCADE_BATCH);
  const candidates = new Set(orphanCandidates);
  for (const row of rows) {
    candidates.add(row.entityId);
    await ctx.db.delete(row._id);
  }
  return {
    more: rows.length === CASCADE_BATCH,
    orphanCandidates: [...candidates],
  };
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
export async function sweepOrphanEntities(
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


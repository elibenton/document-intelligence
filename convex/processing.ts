import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { processingEnqueueOptions, processingPool } from "./processingPool";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { authedAction, authedMutation } from "./authz";
import { keepOwned, requireDocumentFromAction } from "./ownership";

// Watchdog: actions that hit Convex's 10-minute kill never run their catch
// blocks, stranding documents in "parsing"/"extracting" with a "running" job
// forever. The pool's onComplete (processing.jobComplete) is what notices:
// it fires on the kill itself, so no stage needs its own timer.

export const CANCELED_MESSAGE =
  "Processing was stopped before this job started.";


/** Public retry hook for the transcript UI */
export const runTranscription = authedAction({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocumentFromAction(ctx, args.documentId);
    const shouldEnqueue: boolean = await ctx.runMutation(
      internal.processing.createJob,
      {
        documentId: args.documentId,
        stage: "transcribe",
      }
    );
    if (!shouldEnqueue) return null;
    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "uploaded",
    });
    const { paused } = await ctx.runQuery(internal.processingControl.getInternal, {});
    const workId = await processingPool.enqueueAction(
      ctx,
      internal.processingNode.runTranscribe,
      { documentId: args.documentId },
      processingEnqueueOptions(paused, { documentId: args.documentId, stage: "transcribe" })
    );
    await ctx.runMutation(internal.processing.attachWorkId, {
      documentId: args.documentId,
      stage: "transcribe",
      workId,
    });
    return null;
  },
});


// ---------------------------------------------------------------------------
// Upload pipeline: visual documents go through one normal Interfaze completion
// where OCR and object detection happen before metadata analysis is returned.
// Audio/video documents transcribe instead. Entity extraction waits for the
// user to confirm the suggested template.
// ---------------------------------------------------------------------------

export const runFullPipeline = authedAction({
  args: {
    documentId: v.id("documents"),
    bypassCache: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocumentFromAction(ctx, args.documentId);
    // getInternal, not the authenticated get: this action has identity today,
    // but nothing about the read needs it, and the day someone schedules this
    // pipeline the difference is a silent Unauthenticated. No convex/ module
    // should reference `api.*` — see convex/authz.ts.
    const document = await ctx.runQuery(internal.documents.getInternal, {
      id: args.documentId,
    });
    if (!document) throw new Error("Document not found");

    const isRecording =
      document.mediaType === "audio" ||
      document.mediaType === "video" ||
      document.mimeType.startsWith("audio/") ||
      document.mimeType.startsWith("video/");

    const stage = isRecording ? "transcribe" : "parse";
    const shouldEnqueue: boolean = await ctx.runMutation(
      internal.processing.createJob,
      {
        documentId: args.documentId,
        stage,
      }
    );
    if (!shouldEnqueue) return null;
    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "uploaded",
    });
    // This run produces its own Analyze, so a job row left behind by a
    // standalone Analyze retry is stale — leaving it would let an old failure
    // outrank the fresh result in the pipeline UI.
    await ctx.runMutation(internal.processing.clearStageJob, {
      documentId: args.documentId,
      stage: "analyze",
    });
    const { paused } = await ctx.runQuery(internal.processingControl.getInternal, {});
    const workId = isRecording
      ? await processingPool.enqueueAction(
          ctx,
          internal.processingNode.runTranscribe,
          { documentId: args.documentId },
          processingEnqueueOptions(paused, { documentId: args.documentId, stage: "parse" })
        )
      : await processingPool.enqueueAction(
          ctx,
          internal.processingNode.runDocumentUnderstanding,
          {
            documentId: args.documentId,
            ...(args.bypassCache === undefined
              ? {}
              : { bypassCache: args.bypassCache }),
          },
          processingEnqueueOptions(paused, { documentId: args.documentId, stage: "parse" })
        );
    await ctx.runMutation(internal.processing.attachWorkId, {
      documentId: args.documentId,
      stage,
      workId,
    });
    return null;
  },
});


/**
 * Re-run Analyze alone, optionally with a prompt the user edited.
 *
 * Deliberately does not touch Scan: the scan is what extractions, entities and
 * geometry are built on, so it is re-run only when it failed, via
 * runFullPipeline. Analyze is text-in and cheap, so it stays retryable forever.
 */
export const runAnalyze = authedAction({
  args: {
    documentId: v.id("documents"),
    promptOverride: v.optional(v.string()),
    bypassCache: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocumentFromAction(ctx, args.documentId);
    const shouldEnqueue: boolean = await ctx.runMutation(
      internal.processing.createJob,
      { documentId: args.documentId, stage: "analyze" }
    );
    if (!shouldEnqueue) return null;
    const { paused } = await ctx.runQuery(internal.processingControl.getInternal, {});
    const workId = await processingPool.enqueueAction(
      ctx,
      internal.processingNode.runAnalyze,
      args,
      processingEnqueueOptions(paused, { documentId: args.documentId, stage: "analyze" })
    );
    await ctx.runMutation(internal.processing.attachWorkId, {
      documentId: args.documentId,
      stage: "analyze",
      workId,
    });
    return null;
  },
});


/**
 * Re-run parsing for every document stopped by an account-level blocker.
 *
 * These documents didn't fail on their own merits — they hit an empty credit
 * balance or a bad key — so once that's fixed they should resume without the
 * user re-uploading anything. Clearing errorCode alongside the status keeps
 * the banner from lingering after the retry starts.
 */
export const retryBlocked = authedMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    // Owner-scoped for the same reason processingBlocker is: this writes, so
    // an unscoped version lets any signed-in user re-enqueue every blocked
    // document in the deployment and spend someone else's API budget doing it.
    const failed = await keepOwned(
      ctx,
      await ctx.db
        .query("documents")
        .withIndex("by_status", (q) => q.eq("status", "failed"))
        .take(100)
    );

    const blocked = failed.filter((d) =>
      BLOCKING_FAILURE_CODES.has(d.errorCode ?? "")
    );

    // Retrying is the user telling us the block is cleared, so lift the pause
    // the block caused — otherwise this re-enqueues into a pool held at zero
    // parallelism and reads as a button that does nothing. A pause set by hand
    // is left alone, and the enqueue below still honours it.
    await ctx.runMutation(internal.processingControl.resumeAfterProviderBlock, {});
    const { paused } = await ctx.runQuery(internal.processingControl.getInternal, {});

    for (const doc of blocked) {
      await ctx.db.patch(doc._id, {
        status: "uploaded",
        errorMessage: undefined,
        errorCode: undefined,
      });
      const isRecording =
        doc.mediaType === "audio" ||
        doc.mediaType === "video" ||
        doc.mimeType.startsWith("audio/") ||
        doc.mimeType.startsWith("video/");
      const stage = isRecording ? "transcribe" : "parse";
      const job = await ctx.db
        .query("processingJobs")
        .withIndex("by_document", (q) =>
          q.eq("documentId", doc._id).eq("stage", stage)
        )
        .unique();
      const workId = isRecording
        ? await processingPool.enqueueAction(
            ctx,
            internal.processingNode.runTranscribe,
            { documentId: doc._id },
            processingEnqueueOptions(paused, { documentId: doc._id, stage: "parse" })
          )
        : await processingPool.enqueueAction(
            ctx,
            internal.processingNode.runDocumentUnderstanding,
            { documentId: doc._id },
            processingEnqueueOptions(paused, { documentId: doc._id, stage: "parse" })
          );
      if (job) {
        await ctx.db.patch(job._id, {
          status: "pending",
          queuedAt: Date.now(),
          workId,
          startedAt: undefined,
          completedAt: undefined,
          errorMessage: undefined,
        });
      } else {
        await ctx.db.insert("processingJobs", {
          documentId: doc._id,
          stage,
          status: "pending",
          queuedAt: Date.now(),
          workId,
        });
      }
    }
    return blocked.length;
  },
});


// ---------------------------------------------------------------------------
// Extract entities from an already-parsed document
// ---------------------------------------------------------------------------




/**
 * Relationship mapping, queued like every other stage.
 *
 * It used to be a bare `ctx.runAction` at the tail of template extraction, and
 * that cost two things. Template extraction only runs when a human opens the
 * extract dialog, so a document uploaded and processed normally never mapped a
 * single relationship. And a bare runAction has no `onComplete`, so the Convex
 * 10-minute kill left the job row on "running" forever — the exact failure mode
 * processingPool.ts was written to eliminate.
 *
 * Scheduled after Extract rather than awaited inside it: relationship mapping
 * is an enrichment pass, and a document whose extraction succeeded must not be
 * failed by it.
 *
 * Public because that same isolation leaves it without a retry path. A stage
 * that fails without failing its document is invisible to `retryBlocked`,
 * which only sweeps documents whose own status is "failed" — so the Connections
 * step needs its own re-run, the way Analyze and Extract have theirs.
 * `createJob` returning false is what keeps a second click from stacking runs.
 */
async function enqueueRelationships(
  ctx: ActionCtx,
  documentId: Id<"documents">
): Promise<null> {
  const shouldEnqueue: boolean = await ctx.runMutation(
    internal.processing.createJob,
    { documentId, stage: "relationships" }
  );
  if (!shouldEnqueue) return null;
  const { paused } = await ctx.runQuery(internal.processingControl.getInternal, {});
  const workId = await processingPool.enqueueAction(
    ctx,
    internal.relationshipsNode.extract,
    { documentId },
    processingEnqueueOptions(paused, { documentId, stage: "relationships" })
  );
  await ctx.runMutation(internal.processing.attachWorkId, {
    documentId,
    stage: "relationships",
    workId,
  });
  return null;
}

export const runRelationships = authedAction({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocumentFromAction(ctx, args.documentId);
    return await enqueueRelationships(ctx, args.documentId);
  },
});

/**
 * The same enqueue, scheduled by the metadata pass rather than clicked.
 *
 * `ctx.scheduler` does not carry the caller's identity, so scheduling the
 * authenticated `runRelationships` throws Unauthenticated the moment it runs —
 * silently, from the user's point of view, because nothing is awaiting it.
 */
export const runRelationshipsInternal = internalAction({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => enqueueRelationships(ctx, args.documentId),
});


// ---------------------------------------------------------------------------
// Internal mutations for status management
// ---------------------------------------------------------------------------

export const updateStatus = internalMutation({
  args: {
    documentId: v.id("documents"),
    status: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, {
      status: args.status,
      errorMessage: undefined,
      errorCode: undefined,
    });
    return null;
  },
});


export const createJob = internalMutation({
  args: {
    documentId: v.id("documents"),
    stage: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Check if job already exists
    const existing = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", args.stage)
      )
      .first();
    if (existing) {
      // The worker calls createJob again when it starts. Preserve the original
      // queue timestamp so wait-time estimates do not reset to zero.
      if (
        existing.status === "running" ||
        (existing.status === "pending" && existing.workId)
      ) {
        return false;
      }
      await ctx.db.patch(existing._id, {
        status: "pending",
        queuedAt: Date.now(),
        workId: "enqueuing",
        startedAt: undefined,
        completedAt: undefined,
        errorMessage: undefined,
      });
      return true;
    }
    await ctx.db.insert("processingJobs", {
      documentId: args.documentId,
      stage: args.stage,
      status: "pending",
      queuedAt: Date.now(),
      workId: "enqueuing",
    });
    return true;
  },
});

export const attachWorkId = internalMutation({
  args: {
    documentId: v.id("documents"),
    stage: v.string(),
    workId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", args.stage)
      )
      .unique();
    if (job) await ctx.db.patch(job._id, { workId: args.workId });
    return null;
  },
});


export const updateJobStatus = internalMutation({
  args: {
    documentId: v.id("documents"),
    stage: v.string(),
    status: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", args.stage)
      )
      .first();
    if (job) {
      await ctx.db.patch(job._id, {
        status: args.status,
        ...(args.status === "running" ? { startedAt: Date.now() } : {}),
        ...(args.status === "completed" ? { completedAt: Date.now() } : {}),
      });
    } else if ((await ctx.db.get(args.documentId)) !== null) {
      // Only insert for a document that still exists. A stage still running
      // when its document was deleted would otherwise re-create the job row the
      // cascade just removed, and that zombie is read by the queue estimator's
      // global pending/running scan — skewing the position and ETA shown for
      // every other document, forever.
      await ctx.db.insert("processingJobs", {
        documentId: args.documentId,
        stage: args.stage,
        status: args.status,
        queuedAt: Date.now(),
        ...(args.status === "running" ? { startedAt: Date.now() } : {}),
        ...(args.status === "completed" ? { completedAt: Date.now() } : {}),
      });
    }
    return null;
  },
});


/**
 * Dead-man's switch scheduled when a stage starts running. If the job is
 * still "running" long after any action could legally live, the action was
 * killed (timeout/crash) without reaching its catch block — surface the
 * failure instead of showing a spinner forever. A retry refreshes startedAt,
 * so a stale watchdog from an earlier attempt never kills a fresh run.
 */
/**
 * The terminal state for a processing stage, decided in exactly one place.
 *
 * The workpool calls this whether the work succeeded, failed, or was canceled,
 * and — for a pool that retries — only once retries are exhausted. That covers
 * the two cases this layer used to hand-roll:
 *
 *  - A Node action killed at Convex's 10-minute limit never runs its own catch,
 *    so nothing recorded the failure and the document sat on "parsing" forever.
 *    Five stages each armed a `failIfStuck` timer to notice. onComplete fires
 *    on the kill itself, so there is nothing to notice late.
 *  - "Stop processing" cancels queued work. A 64-row self-rescheduling batch
 *    walker used to mark those jobs canceled. A canceled work item reports
 *    itself here instead.
 *
 * A stage's own catch still writes its own failure — that path has a real error
 * message and a FailureCode. This only speaks for the cases where the action
 * never got to speak for itself, so it takes care not to overwrite a verdict
 * that is already terminal.
 */
export const jobComplete = internalMutation({
  args: vOnCompleteArgs(
    v.object({
      documentId: v.id("documents"),
      stage: v.string(),
    })
  ),
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.result.kind === "success") return null;
    const { documentId, stage } = args.context;

    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", documentId).eq("stage", stage)
      )
      .first();

    // The action already recorded its own outcome — leave it.
    if (job && (job.status === "failed" || job.status === "completed")) {
      return null;
    }

    const canceled = args.result.kind === "canceled";
    const errorMessage = canceled
      ? CANCELED_MESSAGE
      : `${stage} stopped before it could finish — the processing action was terminated (document may be too large): ${
          args.result.kind === "failed" ? args.result.error : "unknown"
        }`;

    if (job) {
      await ctx.db.patch(job._id, {
        status: canceled ? "canceled" : "failed",
        errorMessage,
      });
    }

    const doc = await ctx.db.get(documentId);
    if (!doc) return null;
    // A canceled extract leaves a document that is still fully parsed; only an
    // interrupted parse leaves it unusable.
    if (canceled && (stage === "extract" || stage === "relationships")) {
      if (doc.status === "extracting") {
        await ctx.db.patch(documentId, {
          status: "parsed",
          errorMessage: undefined,
          errorCode: undefined,
        });
      }
      return null;
    }
    if (doc.status === "parsing" || doc.status === "extracting") {
      await ctx.db.patch(documentId, {
        status: "failed",
        errorMessage,
        ...(canceled ? { errorCode: "processing_canceled" } : {}),
      });
    }
    return null;
  },
});


/**
 * Failure codes that mean *nothing* will succeed, not that this document is
 * bad — the same two the blocker banner already speaks for.
 */
const BLOCKING_FAILURE_CODES = new Set([
  "insufficient_credits",
  "invalid_api_key",
]);

async function failDocument(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  errorMessage: string,
  errorCode?: string
) {
  await ctx.db.patch(documentId, {
    status: "failed",
    errorMessage,
    errorCode,
  });

  // A provider that is refusing everything will refuse the rest of the queue
  // too, so stop the queue rather than feed it. Every one of the 36 errors in
  // the first ledger was the same exhausted-credits response, each one having
  // shipped a whole document's text to earn it.
  if (errorCode && BLOCKING_FAILURE_CODES.has(errorCode)) {
    await ctx.runMutation(internal.processingControl.pauseForProviderBlock, {});
  }

  // Mark all pending/running jobs as failed
  const jobs = await ctx.db
    .query("processingJobs")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  for (const job of jobs) {
    if (job.status === "pending" || job.status === "running") {
      await ctx.db.patch(job._id, {
        status: "failed",
        errorMessage,
      });
    }
  }
}


/**
 * Fail one stage without failing the document.
 *
 * A stage that runs after the scan (Analyze, on retry) can fail without
 * costing the user anything they already have — the text is stored and the
 * document is still searchable — so the failure belongs on the job row, not on
 * the document banner.
 */
/** Drop a stage's job row, for stages a newer run supersedes. */
export const clearStageJob = internalMutation({
  args: { documentId: v.id("documents"), stage: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", args.stage)
      )
      .first();
    if (job && job.status !== "running") await ctx.db.delete(job._id);
    return null;
  },
});


export const markStageFailed = internalMutation({
  args: {
    documentId: v.id("documents"),
    stage: v.string(),
    errorMessage: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", args.stage)
      )
      .first();
    if (job) {
      await ctx.db.patch(job._id, {
        status: "failed",
        errorMessage: args.errorMessage,
      });
    }
    return null;
  },
});


export const markFailed = internalMutation({
  args: {
    documentId: v.id("documents"),
    errorMessage: v.string(),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await failDocument(
      ctx,
      args.documentId,
      args.errorMessage,
      args.errorCode
    );
    return null;
  },
});

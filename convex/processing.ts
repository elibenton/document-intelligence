import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authedAction, authedMutation } from "./authz";
import { keepOwned, requireDocumentFromAction } from "./ownership";
import { requireBudget, requireBudgetFromAction } from "./budget";
import { documentIssueContext, recordIssue } from "./issues";

// Stages are plain scheduled actions (ctx.scheduler); there is no workpool.
// The two guarantees the pool used to provide are covered by:
//  - sweepStuckJobs (cron): an action killed at the platform limit never runs
//    its catch, so a job left "running" past any legal action lifetime is
//    marked failed there.
//  - deferWhilePaused: each stage action checks the pause flag at start and
//    re-schedules itself instead of spending against a blocked provider.

export const CANCELED_MESSAGE =
  "Processing was stopped before this job started.";

/**
 * Pause gate, called first thing by every pipeline stage action. When
 * processing is paused the action re-schedules itself and records the new
 * scheduled-function id so cancellation still has a handle. Returns true when
 * the caller should return immediately.
 */
export async function deferWhilePaused(
  ctx: ActionCtx,
  job: { documentId: Id<"documents">; stage: string },
  reschedule: () => Promise<Id<"_scheduled_functions">>
): Promise<boolean> {
  const { paused } = await ctx.runQuery(
    internal.processingControl.getInternal,
    {}
  );
  if (!paused) return false;
  const workId = await reschedule();
  await ctx.runMutation(internal.processing.attachWorkId, {
    documentId: job.documentId,
    stage: job.stage,
    workId,
  });
  return true;
}

/** How long to wait before a paused stage re-checks the pause flag. */
export const PAUSE_RECHECK_MS = 60_000;


/** Public retry hook for the transcript UI */
export const runTranscription = authedAction({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocumentFromAction(ctx, args.documentId);
    await requireBudgetFromAction(ctx);
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
    const workId = await ctx.scheduler.runAfter(
      0,
      internal.processingNode.runTranscribe,
      { documentId: args.documentId }
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
    await requireBudgetFromAction(ctx);
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
    const workId = isRecording
      ? await ctx.scheduler.runAfter(0, internal.processingNode.runTranscribe, {
          documentId: args.documentId,
        })
      : await ctx.scheduler.runAfter(
          0,
          internal.processingNode.runDocumentUnderstanding,
          {
            documentId: args.documentId,
            ...(args.bypassCache === undefined
              ? {}
              : { bypassCache: args.bypassCache }),
          }
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
    await requireBudgetFromAction(ctx);
    const shouldEnqueue: boolean = await ctx.runMutation(
      internal.processing.createJob,
      { documentId: args.documentId, stage: "analyze" }
    );
    if (!shouldEnqueue) return null;
    const workId = await ctx.scheduler.runAfter(
      0,
      internal.processingNode.runAnalyze,
      args
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
    await requireBudget(ctx, ctx.user._id);
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
        ? await ctx.scheduler.runAfter(
            0,
            internal.processingNode.runTranscribe,
            { documentId: doc._id }
          )
        : await ctx.scheduler.runAfter(
            0,
            internal.processingNode.runDocumentUnderstanding,
            { documentId: doc._id }
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
 * single relationship. And a bare awaited runAction ties the caller's fate to
 * it — scheduling keeps the job row as the record sweepStuckJobs watches.
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
  const workId = await ctx.scheduler.runAfter(
    0,
    internal.relationshipsNode.extract,
    { documentId }
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
    await requireBudgetFromAction(ctx);
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


// How long a job may sit on "running" before the sweep declares its action
// dead. Default-runtime actions live up to 30 minutes; anything older was
// killed without reaching its catch block.
const STUCK_RUNNING_MS = 35 * 60 * 1000;

/**
 * Mark one canceled job and settle its document, shared by "Stop processing"
 * and document teardown. A canceled extract/relationships leaves a document
 * that is still fully parsed; only an interrupted parse leaves it unusable.
 */
export async function cancelJob(
  ctx: MutationCtx,
  job: { _id: Id<"processingJobs">; documentId: Id<"documents">; stage: string }
) {
  await ctx.db.patch(job._id, {
    status: "canceled",
    errorMessage: CANCELED_MESSAGE,
  });
  const doc = await ctx.db.get(job.documentId);
  if (!doc) return;
  if (job.stage === "extract" || job.stage === "relationships") {
    if (doc.status === "extracting") {
      await ctx.db.patch(job.documentId, {
        status: "parsed",
        errorMessage: undefined,
        errorCode: undefined,
      });
    }
    return;
  }
  if (doc.status === "parsing" || doc.status === "extracting") {
    await ctx.db.patch(job.documentId, {
      status: "failed",
      errorMessage: CANCELED_MESSAGE,
      errorCode: "processing_canceled",
    });
  }
}

/**
 * Watchdog cron. An action killed by the platform (the action time limit,
 * container eviction) never runs its own catch, so nothing records the
 * failure and the document sits on "parsing" forever. A job still "running"
 * long past any legal action lifetime is that case — surface it. A stage's
 * own catch still writes its own failure with a real message and FailureCode;
 * this only speaks for actions that never got to speak for themselves, and a
 * retry refreshes startedAt so it never kills a fresh run.
 */
export const sweepStuckJobs = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - STUCK_RUNNING_MS;
    const running = await ctx.db
      .query("processingJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(200);
    for (const job of running) {
      if ((job.startedAt ?? job._creationTime) >= cutoff) continue;
      const errorMessage = `${job.stage} stopped before it could finish — the processing action was terminated (document may be too large)`;
      await ctx.db.patch(job._id, { status: "failed", errorMessage });
      await recordIssue(ctx, {
        surface: "pipeline",
        stage: job.stage,
        message: errorMessage,
        errorCode: "action_terminated",
        documentId: job.documentId,
        ...(await documentIssueContext(ctx, job.documentId)),
      });
      const doc = await ctx.db.get(job.documentId);
      if (doc && (doc.status === "parsing" || doc.status === "extracting")) {
        await ctx.db.patch(job.documentId, {
          status: "failed",
          errorMessage,
        });
      }
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
  errorCode?: string,
  stage?: string
) {
  await ctx.db.patch(documentId, {
    status: "failed",
    errorMessage,
    errorCode,
  });

  // The document now says what went wrong; the ledger says how often, to how
  // many people, and since which build. Reported before the queue pause below,
  // so an account-level block is counted even on the run that stops the queue.
  await recordIssue(ctx, {
    surface: "pipeline",
    stage: stage ?? "pipeline",
    message: errorMessage,
    errorCode,
    documentId,
    ...(await documentIssueContext(ctx, documentId)),
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
    // Counted even though the document survives. A stage that fails without
    // failing the document is the easiest kind of problem to never notice:
    // nothing turns red, the user keeps their text, and Analyze quietly stops
    // running for a whole class of file.
    await recordIssue(ctx, {
      surface: "pipeline",
      stage: args.stage,
      message: args.errorMessage,
      documentId: args.documentId,
      ...(await documentIssueContext(ctx, args.documentId)),
    });
    return null;
  },
});


export const markFailed = internalMutation({
  args: {
    documentId: v.id("documents"),
    errorMessage: v.string(),
    errorCode: v.optional(v.string()),
    // Which stage is speaking. Optional only because the failure it describes
    // is the document's, not the stage's — but the ledger groups by stage, and
    // "parse timed out" and "transcribe timed out" are not one problem.
    stage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await failDocument(
      ctx,
      args.documentId,
      args.errorMessage,
      args.errorCode,
      args.stage
    );
    return null;
  },
});

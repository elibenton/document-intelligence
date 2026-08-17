import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authedMutation } from "./authz";
import { keepOwned, requireDocument } from "./ownership";
import { requireBudget } from "./budget";
import { documentIssueContext, recordIssue } from "./issues";

// Stages are plain scheduled actions (ctx.scheduler); there is no workpool.
// The two guarantees the pool used to provide are covered by:
//  - sweepStuckJobs (cron): an action killed at the platform limit never runs
//    its catch, so a job left "running" past any legal action lifetime is
//    marked failed there.
//  - bailIfPaused: each stage action checks the pause flag at start and
//    cancels its job instead of spending against a blocked provider; the
//    retry buttons and retryBlocked bring the work back after a resume.

export const CANCELED_MESSAGE =
  "Processing was stopped before this job started.";

/** Extra args a stage's action accepts beyond documentId. */
type StageExtras = { bypassCache?: boolean; promptOverride?: string };

function stageAction(stage: string) {
  switch (stage) {
    case "parse":
      return internal.processingNode.runDocumentUnderstanding;
    case "transcribe":
      return internal.processingNode.runTranscribe;
    case "analyze":
      return internal.processingNode.runAnalyze;
    case "relationships":
      return internal.relationshipsNode.extract;
    default:
      throw new Error(`Unknown pipeline stage: ${stage}`);
  }
}

/**
 * The one way a stage gets queued: dedupe against a live job, schedule the
 * action, and write the job row carrying the scheduled-function id — all in
 * the caller's transaction, so there is no window where a job exists without
 * its handle (the workpool era needed an "enqueuing" placeholder for that).
 * Returns false when a live run already owns the stage.
 */
export async function enqueueStage(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  stage: string,
  extras?: StageExtras
): Promise<boolean> {
  const existing = await ctx.db
    .query("processingJobs")
    .withIndex("by_document", (q) =>
      q.eq("documentId", documentId).eq("stage", stage)
    )
    .first();
  if (
    existing &&
    (existing.status === "running" ||
      (existing.status === "pending" && existing.workId))
  ) {
    return false;
  }
  const workId = await ctx.scheduler.runAfter(0, stageAction(stage), {
    documentId,
    ...(extras?.bypassCache === undefined
      ? {}
      : { bypassCache: extras.bypassCache }),
    ...(extras?.promptOverride === undefined
      ? {}
      : { promptOverride: extras.promptOverride }),
  });
  if (existing) {
    // Preserve nothing from the old run: this is a fresh queue entry.
    await ctx.db.patch(existing._id, {
      status: "pending",
      queuedAt: Date.now(),
      workId,
      startedAt: undefined,
      completedAt: undefined,
      errorMessage: undefined,
    });
  } else {
    await ctx.db.insert("processingJobs", {
      documentId,
      stage,
      status: "pending",
      queuedAt: Date.now(),
      workId,
    });
  }
  return true;
}

/** enqueueStage for callers in action context (stage chaining). */
export const enqueue = internalMutation({
  args: {
    documentId: v.id("documents"),
    stage: v.string(),
    bypassCache: v.optional(v.boolean()),
    promptOverride: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    enqueueStage(ctx, args.documentId, args.stage, args),
});

/**
 * Pause gate, called first thing by every pipeline stage action. When
 * processing is paused the job is canceled rather than run — pause exists to
 * stop spend against a provider that is refusing everything, and canceling is
 * what "Stop processing" already means. Returns true when the caller should
 * return immediately.
 */
export const bailIfPaused = internalMutation({
  args: { documentId: v.id("documents"), stage: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const control = await ctx.db
      .query("processingControl")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    if (!control?.paused) return false;
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", args.stage)
      )
      .first();
    if (job && (job.status === "pending" || job.status === "running")) {
      await cancelJob(ctx, job);
    }
    return true;
  },
});


/** Public retry hook for the transcript UI */
export const runTranscription = authedMutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    await requireBudget(ctx, ctx.user._id);
    if (!(await enqueueStage(ctx, args.documentId, "transcribe"))) return null;
    await ctx.db.patch(args.documentId, {
      status: "uploaded",
      errorMessage: undefined,
      errorCode: undefined,
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

export const runFullPipeline = authedMutation({
  args: {
    documentId: v.id("documents"),
    bypassCache: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await requireDocument(ctx, args.documentId);
    await requireBudget(ctx, ctx.user._id);

    const isRecording =
      document.mediaType === "audio" ||
      document.mediaType === "video" ||
      document.mimeType.startsWith("audio/") ||
      document.mimeType.startsWith("video/");

    const stage = isRecording ? "transcribe" : "parse";
    const enqueued = await enqueueStage(
      ctx,
      args.documentId,
      stage,
      isRecording ? undefined : { bypassCache: args.bypassCache }
    );
    if (!enqueued) return null;
    await ctx.db.patch(args.documentId, {
      status: "uploaded",
      errorMessage: undefined,
      errorCode: undefined,
    });
    // This run produces its own Analyze, so a job row left behind by a
    // standalone Analyze retry is stale — leaving it would let an old failure
    // outrank the fresh result in the pipeline UI.
    await clearStageJobRow(ctx, args.documentId, "analyze");
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
export const runAnalyze = authedMutation({
  args: {
    documentId: v.id("documents"),
    promptOverride: v.optional(v.string()),
    bypassCache: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    await requireBudget(ctx, ctx.user._id);
    await enqueueStage(ctx, args.documentId, "analyze", args);
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
      await enqueueStage(ctx, doc._id, isRecording ? "transcribe" : "parse");
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
export const runRelationships = authedMutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    await requireBudget(ctx, ctx.user._id);
    await enqueueStage(ctx, args.documentId, "relationships");
    return null;
  },
});

/**
 * The same enqueue, scheduled by the metadata pass rather than clicked.
 *
 * `ctx.scheduler` does not carry the caller's identity, so scheduling the
 * authenticated `runRelationships` throws Unauthenticated the moment it runs —
 * silently, from the user's point of view, because nothing is awaiting it.
 */
export const runRelationshipsInternal = internalMutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await enqueueStage(ctx, args.documentId, "relationships");
    return null;
  },
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
async function clearStageJobRow(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  stage: string
) {
  const job = await ctx.db
    .query("processingJobs")
    .withIndex("by_document", (q) =>
      q.eq("documentId", documentId).eq("stage", stage)
    )
    .first();
  if (job && job.status !== "running") await ctx.db.delete(job._id);
}


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

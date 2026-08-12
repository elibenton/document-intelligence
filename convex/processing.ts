import {
  action,
  internalMutation,
  mutation,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { processingEnqueueOptions, processingPool } from "./processingPool";

// Watchdog: actions that hit Convex's 10-minute kill never run their catch
// blocks, stranding documents in "parsing"/"extracting" with a "running" job
// forever. armWatchdog (processingNode.ts) schedules failIfStuck as a
// dead-man's switch; a job still "running" past the action lifetime is dead.

const STALE_AFTER_MS = 11 * 60 * 1000;

const templateRoleValidator = v.object({
  role: v.string(),
  question: v.string(),
  entityType: v.string(),
});


/** Public retry hook for the transcript UI */
export const runTranscription = action({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
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
      processingEnqueueOptions(paused)
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

export const runFullPipeline = action({
  args: {
    documentId: v.id("documents"),
    bypassCache: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(api.documents.get, {
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
    const { paused } = await ctx.runQuery(internal.processingControl.getInternal, {});
    const workId = isRecording
      ? await processingPool.enqueueAction(
          ctx,
          internal.processingNode.runTranscribe,
          { documentId: args.documentId },
          processingEnqueueOptions(paused)
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
          processingEnqueueOptions(paused)
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
 * Re-run parsing for every document stopped by an account-level blocker.
 *
 * These documents didn't fail on their own merits — they hit an empty credit
 * balance or a bad key — so once that's fixed they should resume without the
 * user re-uploading anything. Clearing errorCode alongside the status keeps
 * the banner from lingering after the retry starts.
 */
export const retryBlocked = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const failed = await ctx.db
      .query("documents")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(100);

    const blocked = failed.filter(
      (d) =>
        d.archivedAt === undefined &&
        (d.errorCode === "insufficient_credits" ||
          d.errorCode === "invalid_api_key")
    );
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
            processingEnqueueOptions(paused)
          )
        : await processingPool.enqueueAction(
            ctx,
            internal.processingNode.runDocumentUnderstanding,
            { documentId: doc._id },
            processingEnqueueOptions(paused)
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

export const runExtraction = action({
  args: {
    documentId: v.id("documents"),
    pageSchema: v.string(),
    pageRange: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const shouldEnqueue: boolean = await ctx.runMutation(
      internal.processing.createJob,
      {
        documentId: args.documentId,
        stage: "extract",
      }
    );
    if (!shouldEnqueue) return null;
    const { paused } = await ctx.runQuery(internal.processingControl.getInternal, {});
    const workId = await processingPool.enqueueAction(
      ctx,
      internal.processingNode.runExtract,
      args,
      processingEnqueueOptions(paused)
    );
    await ctx.runMutation(internal.processing.attachWorkId, {
      documentId: args.documentId,
      stage: "extract",
      workId,
    });
    return null;
  },
});

export const runTemplateExtraction = action({
  args: {
    documentId: v.id("documents"),
    roles: v.array(templateRoleValidator),
    saveToKind: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const shouldEnqueue: boolean = await ctx.runMutation(
      internal.processing.createJob,
      { documentId: args.documentId, stage: "extract" }
    );
    if (!shouldEnqueue) return null;
    const { paused } = await ctx.runQuery(internal.processingControl.getInternal, {});
    const workId = await processingPool.enqueueAction(
      ctx,
      internal.processingNode.runTemplateExtraction,
      args,
      processingEnqueueOptions(paused)
    );
    await ctx.runMutation(internal.processing.attachWorkId, {
      documentId: args.documentId,
      stage: "extract",
      workId,
    });
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
    } else {
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
export const failIfStuck = internalMutation({
  args: {
    documentId: v.id("documents"),
    stage: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", args.stage)
      )
      .first();
    if (!job || job.status !== "running") return null;
    if (job.startedAt && Date.now() - job.startedAt < STALE_AFTER_MS) return null;

    const errorMessage = `${args.stage} timed out — the processing action was terminated before it could finish (document may be too large)`;
    await ctx.db.patch(job._id, { status: "failed", errorMessage });

    const doc = await ctx.db.get(args.documentId);
    if (doc && (doc.status === "parsing" || doc.status === "extracting")) {
      await ctx.db.patch(args.documentId, { status: "failed", errorMessage });
    }
    return null;
  },
});


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

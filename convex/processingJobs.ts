import { query } from "./_generated/server";
import { v } from "convex/values";
import { PROCESSING_MAX_PARALLELISM } from "./processingPool";

const jobValidator = v.object({
  _id: v.id("processingJobs"),
  _creationTime: v.number(),
  documentId: v.id("documents"),
  stage: v.string(),
  status: v.string(),
  queuedAt: v.optional(v.number()),
  workId: v.optional(v.string()),
  progress: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  errorMessage: v.optional(v.string()),
});

const estimateValidator = v.union(
  v.null(),
  v.object({
    stage: v.string(),
    status: v.union(v.literal("pending"), v.literal("running")),
    queuedAt: v.number(),
    startedAt: v.optional(v.number()),
    estimatedDurationMs: v.number(),
    estimatedWaitMs: v.number(),
    queuePosition: v.optional(v.number()),
    sampleSize: v.number(),
    paused: v.boolean(),
  })
);

const FALLBACK_DURATION_MS: Record<string, number> = {
  parse: 2 * 60 * 1000,
  transcribe: 3 * 60 * 1000,
  extract: 90 * 1000,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export const byDocument = query({
  args: { documentId: v.id("documents") },
  returns: v.array(jobValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
  },
});

/**
 * A bounded, reactive ETA for the active Workpool-backed stage. Recent median
 * duration is intentionally used instead of an average so one provider timeout
 * cannot make every following estimate wildly pessimistic.
 */
export const estimateByDocument = query({
  args: { documentId: v.id("documents") },
  returns: estimateValidator,
  handler: async (ctx, args) => {
    const documentJobs = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .take(20);
    const active =
      documentJobs.find((job) => job.status === "running" && job.workId) ??
      documentJobs.find((job) => job.status === "pending" && job.workId);
    if (!active || (active.status !== "pending" && active.status !== "running")) {
      return null;
    }
    const control = await ctx.db
      .query("processingControl")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    const paused = control?.paused ?? false;

    const completed = await ctx.db
      .query("processingJobs")
      .withIndex("by_stage_and_status", (q) =>
        q.eq("stage", active.stage).eq("status", "completed")
      )
      .order("desc")
      .take(25);
    const durations = completed.flatMap((job) =>
      job.startedAt !== undefined &&
      job.completedAt !== undefined &&
      job.completedAt > job.startedAt
        ? [job.completedAt - job.startedAt]
        : []
    );
    const estimatedDurationMs =
      durations.length > 0
        ? median(durations)
        : (FALLBACK_DURATION_MS[active.stage] ?? 2 * 60 * 1000);

    if (active.status === "running") {
      return {
        stage: active.stage,
        status: "running" as const,
        queuedAt: active.queuedAt ?? active._creationTime,
        startedAt: active.startedAt,
        estimatedDurationMs,
        estimatedWaitMs: 0,
        sampleSize: durations.length,
        paused,
      };
    }

    const [pending, running] = await Promise.all([
      ctx.db
        .query("processingJobs")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .take(250),
      ctx.db
        .query("processingJobs")
        .withIndex("by_status", (q) => q.eq("status", "running"))
        .take(PROCESSING_MAX_PARALLELISM),
    ]);
    const pooledPending = pending
      .filter((job) => job.workId)
      .sort(
        (a, b) =>
          (a.queuedAt ?? a._creationTime) - (b.queuedAt ?? b._creationTime)
      );
    const index = pooledPending.findIndex((job) => job._id === active._id);
    const queuePosition = index >= 0 ? index + 1 : pooledPending.length + 1;
    const availableWorkers = Math.max(
      0,
      PROCESSING_MAX_PARALLELISM - running.filter((job) => job.workId).length
    );
    const wavesBeforeStart =
      queuePosition <= availableWorkers
        ? 0
        : Math.ceil(
            (queuePosition - availableWorkers) / PROCESSING_MAX_PARALLELISM
          );

    return {
      stage: active.stage,
      status: "pending" as const,
      queuedAt: active.queuedAt ?? active._creationTime,
      estimatedDurationMs,
      estimatedWaitMs: wavesBeforeStart * estimatedDurationMs,
      queuePosition,
      sampleSize: durations.length,
      paused,
    };
  },
});

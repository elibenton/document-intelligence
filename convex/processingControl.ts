import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { v } from "convex/values";
import { processingPool, PROCESSING_MAX_PARALLELISM } from "./processingPool";

const CONTROL_KEY = "global";
const CANCELED_MESSAGE = "Processing was stopped before this job started.";

const controlValidator = v.object({ paused: v.boolean() });

async function readPaused(
  ctx: QueryCtx | MutationCtx
): Promise<boolean> {
  const control = await ctx.db
    .query("processingControl")
    .withIndex("by_key", (q) => q.eq("key", CONTROL_KEY))
    .unique();
  return control?.paused ?? false;
}

export const get = query({
  args: {},
  returns: controlValidator,
  handler: async (ctx) => ({ paused: await readPaused(ctx) }),
});

export const getInternal = internalQuery({
  args: {},
  returns: controlValidator,
  handler: async (ctx) => ({ paused: await readPaused(ctx) }),
});

export const setPaused = mutation({
  args: { paused: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("processingControl")
      .withIndex("by_key", (q) => q.eq("key", CONTROL_KEY))
      .unique();
    const value = {
      key: CONTROL_KEY,
      paused: args.paused,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("processingControl", value);

    await ctx.runMutation(components.processingWorkpool.config.update, {
      maxParallelism: args.paused ? 0 : PROCESSING_MAX_PARALLELISM,
    });
    return null;
  },
});

export const cancelWaiting = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const before = Date.now();
    const existing = await ctx.db
      .query("processingControl")
      .withIndex("by_key", (q) => q.eq("key", CONTROL_KEY))
      .unique();
    const value = { key: CONTROL_KEY, paused: true, updatedAt: Date.now() };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("processingControl", value);

    // Freeze new starts first. Workpool cancellation is cooperative: queued
    // work will not start, while actions already running are allowed to finish.
    await ctx.runMutation(components.processingWorkpool.config.update, {
      maxParallelism: 0,
    });
    await processingPool.cancelAll(ctx);
    await ctx.scheduler.runAfter(0, internal.processingControl.markCanceledBatch, {
      before,
    });
    return null;
  },
});

export const markCanceledBatch = internalMutation({
  args: { before: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("processingJobs")
      .withIndex("by_status_and_queuedAt", (q) =>
        q.eq("status", "pending").lte("queuedAt", args.before)
      )
      .take(64);
    for (const job of pending) {
      await ctx.db.patch(job._id, {
        status: "canceled",
        errorMessage: CANCELED_MESSAGE,
      });
      const document = await ctx.db.get(job.documentId);
      if (!document) continue;
      if (job.stage === "extract") {
        await ctx.db.patch(job.documentId, {
          status: "parsed",
          errorMessage: undefined,
          errorCode: undefined,
        });
      } else {
        await ctx.db.patch(job.documentId, {
          status: "failed",
          errorMessage: CANCELED_MESSAGE,
          errorCode: "processing_canceled",
        });
      }
    }
    if (pending.length === 64) {
      await ctx.scheduler.runAfter(0, internal.processingControl.markCanceledBatch, {
        before: args.before,
      });
    }
    return null;
  },
});

import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { v } from "convex/values";
import { processingPool, PROCESSING_MAX_PARALLELISM } from "./processingPool";

const CONTROL_KEY = "global";
const CANCELED_MESSAGE = "Processing was stopped before this job started.";

/** `pausedReason` for a pause the pipeline gave itself. See schema.ts. */
export const PROVIDER_BLOCKED = "provider_blocked";

const controlValidator = v.object({
  paused: v.boolean(),
  pausedReason: v.optional(v.string()),
});

async function readControl(ctx: QueryCtx | MutationCtx) {
  return await ctx.db
    .query("processingControl")
    .withIndex("by_key", (q) => q.eq("key", CONTROL_KEY))
    .unique();
}

async function writeControl(
  ctx: MutationCtx,
  paused: boolean,
  pausedReason?: string
) {
  const existing = await readControl(ctx);
  const value = {
    key: CONTROL_KEY,
    paused,
    ...(paused && pausedReason ? { pausedReason } : {}),
    updatedAt: Date.now(),
  };
  if (existing) await ctx.db.replace(existing._id, value);
  else await ctx.db.insert("processingControl", value);

  await ctx.runMutation(components.processingWorkpool.config.update, {
    maxParallelism: paused ? 0 : PROCESSING_MAX_PARALLELISM,
  });
}

export const get = query({
  args: {},
  returns: controlValidator,
  handler: async (ctx) => {
    const control = await readControl(ctx);
    return {
      paused: control?.paused ?? false,
      ...(control?.pausedReason ? { pausedReason: control.pausedReason } : {}),
    };
  },
});

export const getInternal = internalQuery({
  args: {},
  returns: controlValidator,
  handler: async (ctx) => {
    const control = await readControl(ctx);
    return {
      paused: control?.paused ?? false,
      ...(control?.pausedReason ? { pausedReason: control.pausedReason } : {}),
    };
  },
});

export const setPaused = mutation({
  args: { paused: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // A human touching the control takes ownership of it: pausing by hand is
    // not a provider block, and resuming by hand clears one.
    await writeControl(ctx, args.paused);
    return null;
  },
});

/**
 * Stop the queue because the provider is refusing everything.
 *
 * Out of credits or a rejected key fails every document identically, and the
 * workpool has no idea — it keeps dequeuing, and each job inlines an entire
 * document into a request that cannot succeed. One failure is information;
 * the next forty are just spend and noise in the log.
 *
 * Only ever pauses. It will not overwrite a pause a human already set (there
 * is nothing to change) and it never resumes — clearing this is
 * `resumeAfterProviderBlock` or the Resume button, both of which mean someone
 * has dealt with the cause.
 */
export const pauseForProviderBlock = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const control = await readControl(ctx);
    if (control?.paused) return null;
    await writeControl(ctx, true, PROVIDER_BLOCKED);
    return null;
  },
});

/**
 * Clear an automatic pause, and only an automatic one.
 *
 * Retrying the blocked documents is the user saying the cause is fixed, so the
 * queue that stopped itself has to start again — otherwise the retry enqueues
 * into a pool with zero parallelism and looks like a button that does nothing.
 * A pause someone set deliberately survives, because they did not ask for it
 * to be lifted.
 */
export const resumeAfterProviderBlock = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const control = await readControl(ctx);
    if (!control?.paused || control.pausedReason !== PROVIDER_BLOCKED) {
      return false;
    }
    await writeControl(ctx, false);
    return true;
  },
});

export const cancelWaiting = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const before = Date.now();
    // Freeze new starts first. Workpool cancellation is cooperative: queued
    // work will not start, while actions already running are allowed to finish.
    // Stopping the queue by hand is a deliberate pause, so it carries no
    // reason and no later retry will lift it automatically.
    await writeControl(ctx, true);
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

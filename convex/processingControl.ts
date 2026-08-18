import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { cancelJob } from "./processing";
import { adminMutation, authedQuery } from "./authz";

const CONTROL_KEY = "global";

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
  // Nothing else to flip: every stage action checks this flag as it starts
  // (processing.bailIfPaused) and cancels its job while it holds.
}

export const get = authedQuery({
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

export const setPaused = adminMutation({
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
 * scheduler has no idea — every queued stage still runs, and each one inlines an entire
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

export const cancelWaiting = adminMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Freeze new starts first. Cancellation is cooperative: a queued stage
    // will not start, while actions already running are allowed to finish.
    // Stopping the queue by hand is a deliberate pause, so it carries no
    // reason and no later retry will lift it automatically.
    await writeControl(ctx, true);
    const pending = await ctx.db
      .query("processingJobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(500);
    for (const job of pending) {
      if (job.workId && job.workId !== "enqueuing") {
        // Pre-scheduler rows can carry an id the scheduler cannot parse.
        try {
          await ctx.scheduler.cancel(job.workId as Id<"_scheduled_functions">);
        } catch {
          // Nothing to cancel — the job row below is still marked canceled.
        }
      }
      await cancelJob(ctx, job);
    }
    return null;
  },
});

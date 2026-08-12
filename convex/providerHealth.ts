/**
 * Provider health tracking.
 *
 * An exhausted Gemini quota does not break the app — it silently removes the
 * semantic leg from search, so answers get quietly worse while everything
 * still looks like it works. This module records the real outcome of every
 * provider call so the settings page can say so out loud.
 *
 * Actions build a reporter with `healthReporter(ctx)` and hand it to the API
 * client helpers, mirroring how `usageLogger` is threaded through.
 */

import { internalMutation, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export type ProviderStatus =
  | "ok"
  | "quota_exhausted"
  | "auth_failed"
  | "error"
  | "not_configured";

export type HealthReport = {
  provider: string;
  status: ProviderStatus;
  message?: string;
};

export type HealthReporter = (report: HealthReport) => Promise<void>;

/**
 * While healthy, only persist a heartbeat this often. Without this a bulk
 * embedding backfill would rewrite the row on every single batch.
 */
const OK_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Build a HealthReporter bound to an action's ctx. Reporting must never break
 * the call it describes, so failures are swallowed with a console error.
 */
export function healthReporter(ctx: ActionCtx): HealthReporter {
  return async (report: HealthReport) => {
    try {
      await ctx.runMutation(internal.providerHealth.report, report);
    } catch (e) {
      console.error("Failed to record provider health:", e);
    }
  };
}

export const report = internalMutation({
  args: {
    provider: v.string(),
    status: v.string(),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const isOk = args.status === "ok";
    const existing = await ctx.db
      .query("providerHealth")
      .withIndex("by_provider", (q) => q.eq("provider", args.provider))
      .unique();

    if (!existing) {
      await ctx.db.insert("providerHealth", {
        provider: args.provider,
        status: args.status,
        message: args.message?.slice(0, 500),
        lastOkAt: isOk ? now : undefined,
        lastErrorAt: isOk ? undefined : now,
        consecutiveFailures: isOk ? 0 : 1,
        updatedAt: now,
      });
      return;
    }

    // Steady-state success needs no write until the heartbeat goes stale.
    if (
      isOk &&
      existing.status === "ok" &&
      now - existing.updatedAt < OK_HEARTBEAT_MS
    ) {
      return;
    }

    await ctx.db.patch(existing._id, {
      status: args.status,
      message: args.message?.slice(0, 500),
      lastOkAt: isOk ? now : existing.lastOkAt,
      lastErrorAt: isOk ? existing.lastErrorAt : now,
      consecutiveFailures: isOk ? 0 : existing.consecutiveFailures + 1,
      updatedAt: now,
    });
  },
});

/** Every tracked provider's current state, for the settings page. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("providerHealth").take(20);
  },
});

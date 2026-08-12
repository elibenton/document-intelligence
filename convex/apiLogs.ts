/**
 * Mini API log: one row per external AI API call (Interfaze chat completions,
 * OpenAI embeddings) with token usage and estimated cost. Actions construct a
 * logger with `usageLogger(ctx, ...)` and hand it to the API client helpers;
 * the settings page reads `list` and `totals`.
 */

import { internalMutation, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ApiUsage, UsageLogger } from "./interfaze";

/** Shard count for the denormalized usage totals (see schema.apiUsageTotals). */
const TOTALS_SHARDS = 8;

/**
 * Build a UsageLogger bound to an action's ctx. Logging must never break the
 * pipeline call it describes, so failures are swallowed with a console error.
 */
export function usageLogger(
  ctx: ActionCtx,
  meta?: { documentId?: Id<"documents"> }
): UsageLogger {
  return async (usage: ApiUsage) => {
    try {
      await ctx.runMutation(internal.apiLogs.record, {
        ...usage,
        documentId: meta?.documentId,
      });
    } catch (e) {
      console.error("Failed to record API usage:", e);
    }
  };
}

export const record = internalMutation({
  args: {
    provider: v.string(),
    operation: v.string(),
    model: v.string(),
    status: v.union(v.literal("ok"), v.literal("error")),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    costUsd: v.number(),
    durationMs: v.number(),
    cacheHit: v.optional(v.boolean()),
    error: v.optional(v.string()),
    documentId: v.optional(v.id("documents")),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("apiLogs", {
      ...args,
      error: args.error?.slice(0, 500),
    });

    // Spread the running total across shards: parallel chunk parses all log
    // at once, and a single counter row would make every one of them contend
    // for the same document.
    const shard = Math.floor(Math.random() * TOTALS_SHARDS);
    const totals = await ctx.db
      .query("apiUsageTotals")
      .withIndex("by_shard", (q) => q.eq("shard", shard))
      .unique();
    if (totals) {
      await ctx.db.patch(totals._id, {
        calls: totals.calls + 1,
        promptTokens: totals.promptTokens + args.promptTokens,
        completionTokens: totals.completionTokens + args.completionTokens,
        costUsd: totals.costUsd + args.costUsd,
        cacheMeasuredCalls:
          (totals.cacheMeasuredCalls ?? 0) +
          (args.cacheHit === undefined ? 0 : 1),
        cacheHits: (totals.cacheHits ?? 0) + (args.cacheHit ? 1 : 0),
      });
    } else {
      await ctx.db.insert("apiUsageTotals", {
        shard,
        calls: 1,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        costUsd: args.costUsd,
        cacheMeasuredCalls: args.cacheHit === undefined ? 0 : 1,
        cacheHits: args.cacheHit ? 1 : 0,
      });
    }
  },
});

/** Most recent API calls, newest first, with the document name joined in. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db.query("apiLogs").order("desc").take(100);
    return await Promise.all(
      logs.map(async (log) => {
        const doc = log.documentId ? await ctx.db.get(log.documentId) : null;
        return { ...log, documentName: doc?.name };
      })
    );
  },
});

export const totals = query({
  args: {},
  handler: async (ctx) => {
    // At most TOTALS_SHARDS rows (+1 legacy unsharded row), so this stays a
    // fixed-size read no matter how large the log grows.
    const shards = await ctx.db
      .query("apiUsageTotals")
      .take(TOTALS_SHARDS + 1);
    return shards.reduce(
      (sum, t) => ({
        calls: sum.calls + t.calls,
        promptTokens: sum.promptTokens + t.promptTokens,
        completionTokens: sum.completionTokens + t.completionTokens,
        costUsd: sum.costUsd + t.costUsd,
        cacheMeasuredCalls:
          sum.cacheMeasuredCalls + (t.cacheMeasuredCalls ?? 0),
        cacheHits: sum.cacheHits + (t.cacheHits ?? 0),
      }),
      {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        cacheMeasuredCalls: 0,
        cacheHits: 0,
      }
    );
  },
});

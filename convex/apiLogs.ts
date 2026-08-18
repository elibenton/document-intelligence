/**
 * Mini API log: one row per external AI API call (Interfaze chat completions,
 * OpenAI embeddings) with token usage and estimated cost. Actions construct a
 * logger with `usageLogger(ctx, ...)` and hand it to the API client helpers;
 * the settings page reads `list` and `totals`.
 */

import { internalMutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ApiUsage, UsageLogger } from "./interfazeCost";
import { authedQuery } from "./authz";
import { chargeUsage } from "./budget";
import { recordIssue } from "./issues";
import { requireDocument } from "./ownership";

/** Shard count for the denormalized usage totals (see schema.apiUsageTotals). */
export const TOTALS_SHARDS = 8;

/**
 * Build a UsageLogger bound to an action's ctx. Logging must never break the
 * pipeline call it describes, so failures are swallowed with a console error.
 */
export function usageLogger(
  ctx: ActionCtx,
  meta?: { documentId?: Id<"documents">; projectId?: Id<"projects"> }
): UsageLogger {
  return async (usage: ApiUsage) => {
    try {
      await ctx.runMutation(internal.apiLogs.record, {
        ...usage,
        documentId: meta?.documentId,
        projectId: meta?.projectId,
      });
    } catch (e) {
      console.error("Failed to record API usage:", e);
    }
  };
}

/**
 * One measurement row for a pipeline stage reaching terminal state, written by
 * the stage-lifecycle mutations in convex/processing.ts.
 *
 * Deliberately a direct insert rather than a call through `record`: a stage is
 * not an API call, so it must not increment `apiUsageTotals.calls`, charge the
 * spend ledger, or file a provider issue (processing.ts files its own pipeline
 * issues). What it shares with API rows is the table, so per-document cost and
 * per-stage latency can be read side by side.
 */
export async function recordStageTiming(
  ctx: MutationCtx,
  job: {
    _creationTime: number;
    documentId: Id<"documents">;
    stage: string;
    // Optional on legacy rows; row creation time is the honest fallback.
    queuedAt?: number;
    startedAt?: number;
  },
  outcome: "ok" | "error"
) {
  try {
    const now = Date.now();
    const queuedAt = job.queuedAt ?? job._creationTime;
    const projectId = (await ctx.db.get(job.documentId))?.projectId;
    const ownerId = projectId
      ? (await ctx.db.get(projectId))?.ownerId
      : undefined;
    await ctx.db.insert("apiLogs", {
      provider: "pipeline",
      operation: `stage:${job.stage}`,
      model: "-",
      status: outcome,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: now - (job.startedAt ?? queuedAt),
      queuedMs: job.startedAt ? job.startedAt - queuedAt : undefined,
      documentId: job.documentId,
      ownerId,
      buildSha: process.env.BUILD_SHA?.slice(0, 7),
    });
  } catch (e) {
    // Same contract as usageLogger: measurement must never break the
    // lifecycle transition it describes.
    console.error("Failed to record stage timing:", e);
  }
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
    // Search logs a project rather than a document — it is asking a question
    // of the whole corpus. Either one resolves to the same owner below.
    projectId: v.optional(v.id("projects")),
    // Measurement fields. All optional: rows written before this landed have
    // none of them, and non-Interfaze callers (embeddings) supply none either.
    finishReason: v.optional(v.string()),
    promptHash: v.optional(v.string()),
    outputHash: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    buildSha: v.optional(v.string()),
    retryCount: v.optional(v.number()),
    qualityChecked: v.optional(v.number()),
    qualityViolations: v.optional(v.number()),
    qualityByKind: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, args) => {
    // Resolved here rather than at the twelve logging call sites: this mutation
    // is the one place every recorded call passes through, so a new call site
    // cannot forget to attribute itself. There is no `ctx.auth` to read — this
    // runs inside the scheduler → internal action chain, where
    // Convex does not propagate identity, so ownership has to arrive as data.
    const { projectId: metaProjectId, ...row } = args;
    const projectId =
      metaProjectId ??
      (args.documentId
        ? (await ctx.db.get(args.documentId))?.projectId
        : undefined);
    const ownerId = projectId
      ? (await ctx.db.get(projectId))?.ownerId
      : undefined;

    await ctx.db.insert("apiLogs", {
      ...row,
      error: args.error?.slice(0, 500),
      ownerId,
    });

    // The provider's own verdict, counted separately from the document's.
    //
    // Most of these do go on to fail a document, and are reported again from
    // convex/processing.ts — deliberately, because they are two different
    // facts. "Interfaze returned a 529" and "this document failed" have
    // different rates whenever a stage retries or degrades, and it is precisely
    // the gap between them that says a failure is being absorbed rather than
    // fixed. The embeddings caller is the clearest case: a quota error there
    // silently drops the semantic leg of search and fails nothing at all.
    if (args.status === "error" && args.error) {
      await recordIssue(ctx, {
        surface: "provider",
        // Qualified by provider, since "embed" means one thing to OpenAI and
        // the operation names are not unique across them.
        stage: `${args.provider}:${args.operation}`,
        message: args.error,
        errorCode: args.errorCode,
        documentId: args.documentId,
        ownerId,
        buildSha: args.buildSha,
      });
    }

    // The spend ledger the cap is read from. Here rather than at the call
    // sites for the same reason ownerId is resolved here: this mutation is the
    // one place every billable call passes through.
    await chargeUsage(ctx, ownerId, args.costUsd);

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

/**
 * Most recent API calls, newest first, with the document name joined in.
 *
 * The join is deduplicated by document id: one 20-page ingest writes ~28 log
 * rows that all point at the same document, so the naive per-row `get` did up
 * to 100 reads to answer a question with a handful of distinct answers.
 */
export const list = authedQuery({
  args: {},
  handler: async (ctx) => {
    // `by_owner`, not the bare table scan this used to do: the rows carry the
    // provider's raw error text and join to document names, so an unscoped
    // feed showed every account the titles of everyone else's documents.
    // Unattributed rows (pre-auth, or orphaned) belong to nobody and so appear
    // for nobody — the admin dashboard is where they are accounted for.
    const logs = await ctx.db
      .query("apiLogs")
      .withIndex("by_owner", (q) => q.eq("ownerId", ctx.user._id))
      .order("desc")
      .take(100);
    const names = new Map<Id<"documents">, string | undefined>();
    for (const id of new Set(logs.flatMap((l) => (l.documentId ? [l.documentId] : [])))) {
      names.set(id, (await ctx.db.get(id))?.name);
    }
    return logs.map((log) => ({
      ...log,
      documentName: log.documentId ? names.get(log.documentId) : undefined,
    }));
  },
});

/**
 * What one document cost, per pipeline operation.
 *
 * Aggregated here rather than shipping the raw rows: the document page only
 * renders one line per operation, and the rows carry the provider's raw error
 * text, which the viewer has no use for. Ordered by each operation's first
 * call, which is pipeline order without hardcoding the pipeline.
 *
 * `durationMs` is summed across calls, so chunked stages that run in parallel
 * report more API time than wall-clock time — the UI says so where it shows it.
 * Rows expire after 30 days (pruneOldLogs), so an old document legitimately
 * answers with less than it spent, or nothing.
 */
export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    const logs = await ctx.db
      .query("apiLogs")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const byOperation = new Map<
      string,
      {
        operation: string;
        calls: number;
        errors: number;
        promptTokens: number;
        completionTokens: number;
        costUsd: number;
        durationMs: number;
        cacheHits: number;
        firstCallAt: number;
      }
    >();
    for (const log of logs) {
      const row = byOperation.get(log.operation) ?? {
        operation: log.operation,
        calls: 0,
        errors: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        durationMs: 0,
        cacheHits: 0,
        firstCallAt: log._creationTime,
      };
      row.calls += 1;
      if (log.status === "error") row.errors += 1;
      row.promptTokens += log.promptTokens;
      row.completionTokens += log.completionTokens;
      row.costUsd += log.costUsd;
      row.durationMs += log.durationMs;
      if (log.cacheHit) row.cacheHits += 1;
      byOperation.set(log.operation, row);
    }
    return [...byOperation.values()].sort(
      (a, b) => a.firstCallAt - b.firstCallAt
    );
  },
});

/**
 * Retention. Nothing deleted these rows, so the log grew without bound in the
 * same database as app data.
 *
 * Safe to delete detail because the lifetime ledger does not live here: the
 * sharded `apiUsageTotals` rows carry calls/tokens/cost forever and are never
 * pruned. What ages out is the per-call measurement detail, which answers
 * "what changed this week", not "what have we spent".
 */
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_BATCH = 200;

export const pruneOldLogs = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    const stale = await ctx.db
      .query("apiLogs")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(RETENTION_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
    // Re-arm while a backlog remains, so the first run after a long gap does
    // not have to fit the whole history into one mutation.
    if (stale.length === RETENTION_BATCH) {
      await ctx.scheduler.runAfter(0, internal.apiLogs.pruneOldLogs, {});
    }
    return null;
  },
});

/**
 * Lifetime spend, summed across the shards. Shared with convex/admin.ts so the
 * settings page and the admin dashboard cannot disagree about what has been
 * spent.
 *
 * Note the fixed-size read below: it is correct only while this table holds at
 * most TOTALS_SHARDS rows plus one legacy row. Giving `apiUsageTotals` a
 * per-user dimension would grow it to accounts × shards and make this silently
 * under-report, with no error anywhere — see docs/admin-usage-plan.md §4.5.
 */
export async function readLifetimeTotals(ctx: QueryCtx) {
  const shards = await ctx.db.query("apiUsageTotals").take(TOTALS_SHARDS + 1);
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
}

export const totals = authedQuery({
  args: {},
  handler: async (ctx) => readLifetimeTotals(ctx),
});

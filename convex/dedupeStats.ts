import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authedQuery } from "./authz";
import { requireProject } from "./ownership";

export type DedupeCounterField =
  | "suggested"
  | "accepted"
  | "rejected"
  | "manualMerges"
  | "unmerges"
  | "resolvedExisting"
  | "createdNew";

/**
 * Bump one counter on the project's dedupe ledger, creating the row on first
 * touch. Write rates here are human-paced (merges) or one-per-extracted-name
 * (resolver), nowhere near the contention that made apiUsageTotals shard —
 * one row per project is fine.
 */
export async function bumpDedupeCounter(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  field: DedupeCounterField,
  by = 1
) {
  const existing = await ctx.db
    .query("dedupeCounters")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, {
      [field]: existing[field] + by,
      updatedAt: Date.now(),
    });
  } else {
    await ctx.db.insert("dedupeCounters", {
      projectId,
      suggested: 0,
      accepted: 0,
      rejected: 0,
      manualMerges: 0,
      unmerges: 0,
      resolvedExisting: 0,
      createdNew: 0,
      [field]: by,
      updatedAt: Date.now(),
    });
  }
}

/**
 * The project's dedupe health: lifetime counters plus the current pending
 * backlog (bounded count — ">50" is as much resolution as the UI needs).
 */
export const dedupeStats = authedQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    const counters = await ctx.db
      .query("dedupeCounters")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const pending = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "pending")
      )
      .take(51);
    return {
      pending: pending.length,
      pendingCapped: pending.length > 50,
      suggested: counters?.suggested ?? 0,
      accepted: counters?.accepted ?? 0,
      rejected: counters?.rejected ?? 0,
      manualMerges: counters?.manualMerges ?? 0,
      unmerges: counters?.unmerges ?? 0,
      resolvedExisting: counters?.resolvedExisting ?? 0,
      createdNew: counters?.createdNew ?? 0,
    };
  },
});

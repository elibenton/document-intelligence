import { v } from "convex/values";
import { adminQuery } from "./authz";
import { authComponent } from "./auth";
import { readLifetimeTotals } from "./apiLogs";

/**
 * What the deployment is spending, for the owner.
 *
 * Everything here is a number or a value from a vocabulary this codebase wrote
 * itself. Nothing document-derived leaves this file — no document name, no page
 * text, no entity, no `documentId`, and in particular neither `apiLogs.error`
 * (its fallback branch splices 300 chars of the provider's message, which for a
 * parse call can echo the storage URL we sent it) nor `outputHash` (a 32-bit
 * FNV-1a of the model's raw output, which for a rename is brute-forceable back
 * to a document title). docs/admin-usage-plan.md §2 has the full field-by-field
 * reasoning.
 *
 * Two things keep that true as this file grows, neither of them a comment: the
 * explicit `returns` validators below, which make an accidental `...row` spread
 * fail rather than leak; and the eslint fence on this path, which bans
 * `ctx.db.get` and any table other than the two.
 *
 * The one exception is deliberate and narrow: the per-account table resolves a
 * name and email through the Better Auth component, because the owner asked to
 * see who is spending. That table holds identity and nothing a user wrote, so
 * it does not weaken the rule above — "cannot read their documents" is intact,
 * "cannot tell who they are" is what was traded away.
 */

/**
 * Rows scanned per request. This is a reactive subscription, so every new log
 * row re-runs the scan — and a bulk ingest writes ~28 rows per document. The
 * cap is surfaced as `truncated` rather than silently presenting a floor as a
 * total, which is the same failure mode as the hardcoded `.take(9)` in
 * apiLogs.totals. When it starts coming back true, denormalise into a daily
 * table; see docs/admin-usage-plan.md §5.5.
 */
const SCAN_LIMIT = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

export const usage = adminQuery({
  args: { days: v.number() },
  returns: v.object({
    lifetime: v.object({
      calls: v.number(),
      promptTokens: v.number(),
      completionTokens: v.number(),
      costUsd: v.number(),
      cacheMeasuredCalls: v.number(),
      cacheHits: v.number(),
    }),
    window: v.object({
      days: v.number(),
      calls: v.number(),
      promptTokens: v.number(),
      completionTokens: v.number(),
      costUsd: v.number(),
      errors: v.number(),
      documentsTouched: v.number(),
      truncated: v.boolean(),
    }),
    byOperation: v.array(
      v.object({
        operation: v.string(),
        calls: v.number(),
        costUsd: v.number(),
        errors: v.number(),
        truncatedOutputs: v.number(),
        p50DurationMs: v.number(),
        p95DurationMs: v.number(),
      })
    ),
    byDay: v.array(
      v.object({ day: v.string(), calls: v.number(), costUsd: v.number() })
    ),
    // The override harvest: human edits that displaced an AI value, per
    // field, against the window's analyze-call count — the rejection rate
    // the *Source stamps exist to measure. Rows are `override:<field>`
    // inserts from recordOverride.
    overrides: v.object({
      analyzeCalls: v.number(),
      byField: v.array(v.object({ field: v.string(), count: v.number() })),
    }),
    byAccount: v.array(
      v.object({
        account: v.string(),
        name: v.optional(v.string()),
        email: v.optional(v.string()),
        calls: v.number(),
        costUsd: v.number(),
        promptTokens: v.number(),
        completionTokens: v.number(),
        errors: v.number(),
        documentsTouched: v.number(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const lifetime = await readLifetimeTotals(ctx);

    const cutoff = Date.now() - args.days * DAY_MS;
    const rows = await ctx.db
      .query("apiLogs")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", cutoff))
      .take(SCAN_LIMIT);

    const window = {
      days: args.days,
      calls: rows.length,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      errors: 0,
      // A Set size, never the ids themselves — see §2.3. This is "how much of
      // the corpus did this spend touch", which is a number.
      documentsTouched: 0,
      truncated: rows.length === SCAN_LIMIT,
    };
    const documentIds = new Set<string>();

    const ops = new Map<
      string,
      { calls: number; costUsd: number; errors: number; truncatedOutputs: number; durations: number[] }
    >();
    const days = new Map<string, { calls: number; costUsd: number }>();

    /**
     * Per-account spend, keyed by the Better Auth user id.
     *
     * The name and email are resolved below. An earlier version of this
     * deliberately showed only an 8-character id prefix, on the reasoning that
     * the dashboard should be able to measure an account without identifying
     * it. The owner asked for the names, which is the right call: a dashboard
     * whose whole purpose is noticing a runaway account is not much use if
     * acting on what it shows requires a separate lookup somewhere else.
     *
     * What that does *not* open is the thing this file exists to prevent. The
     * identity join reads the Better Auth user table, which holds a name and an
     * email and nothing a user wrote. Document titles, page text and entities
     * remain unreachable from here, and the two eslint rules that enforce that
     * are unchanged.
     *
     * Rows with no owner are a real category, not a rounding error: they
     * predate accounts, or their document has since been deleted. Showing them
     * as `Unattributed` is honest, and is also the only way to notice if
     * resolution in apiLogs.record ever silently stops working.
     */
    const accounts = new Map<
      string | null, // null is the Unattributed bucket; ids cannot collide
      {
        calls: number;
        costUsd: number;
        promptTokens: number;
        completionTokens: number;
        errors: number;
        documents: Set<string>;
      }
    >();

    for (const row of rows) {
      window.promptTokens += row.promptTokens ?? 0;
      window.completionTokens += row.completionTokens ?? 0;
      window.costUsd += row.costUsd ?? 0;
      if (row.status === "error") window.errors += 1;
      if (row.documentId) documentIds.add(row.documentId);

      const op = ops.get(row.operation) ?? {
        calls: 0,
        costUsd: 0,
        errors: 0,
        truncatedOutputs: 0,
        durations: [],
      };
      op.calls += 1;
      op.costUsd += row.costUsd ?? 0;
      if (row.status === "error") op.errors += 1;
      // A response the model ran out of room to finish is a correctness
      // problem wearing a cost problem's clothes, so it is worth its own count.
      if (row.finishReason === "length") op.truncatedOutputs += 1;
      if (typeof row.durationMs === "number") op.durations.push(row.durationMs);
      ops.set(row.operation, op);

      // Bucketed to the day on purpose: a per-call timestamp feed is a
      // work-hours trace of another person, which is not what this answers.
      const day = new Date(row._creationTime).toISOString().slice(0, 10);
      const bucket = days.get(day) ?? { calls: 0, costUsd: 0 };
      bucket.calls += 1;
      bucket.costUsd += row.costUsd ?? 0;
      days.set(day, bucket);

      const account = row.ownerId ?? null;
      const acct = accounts.get(account) ?? {
        calls: 0,
        costUsd: 0,
        promptTokens: 0,
        completionTokens: 0,
        errors: 0,
        documents: new Set<string>(),
      };
      acct.calls += 1;
      acct.costUsd += row.costUsd ?? 0;
      acct.promptTokens += row.promptTokens ?? 0;
      acct.completionTokens += row.completionTokens ?? 0;
      if (row.status === "error") acct.errors += 1;
      // Collected only to be counted — the ids never leave this handler, and
      // the `returns` validator above would reject them if they tried.
      if (row.documentId) acct.documents.add(row.documentId);
      accounts.set(account, acct);
    }

    window.documentsTouched = documentIds.size;

    // The override harvest, from the same window scan: `override:<field>`
    // rows are zero-cost human-rejection markers (see apiLogs.recordOverride).
    const overrideCounts = new Map<string, number>();
    let analyzeCalls = 0;
    for (const row of rows) {
      if (row.operation === "analyze" && row.status === "ok") analyzeCalls++;
      else if (row.operation.startsWith("override:")) {
        const field = row.operation.slice("override:".length);
        overrideCounts.set(field, (overrideCounts.get(field) ?? 0) + 1);
      }
    }

    return {
      lifetime,
      window,
      overrides: {
        analyzeCalls,
        byField: [...overrideCounts.entries()]
          .map(([field, count]) => ({ field, count }))
          .sort((a, b) => b.count - a.count),
      },
      byOperation: [...ops.entries()]
        .map(([operation, o]) => {
          const sorted = [...o.durations].sort((a, b) => a - b);
          return {
            operation,
            calls: o.calls,
            costUsd: o.costUsd,
            errors: o.errors,
            truncatedOutputs: o.truncatedOutputs,
            p50DurationMs: percentile(sorted, 50),
            p95DurationMs: percentile(sorted, 95),
          };
        })
        .sort((a, b) => b.costUsd - a.costUsd),
      byDay: [...days.entries()]
        .map(([day, d]) => ({ day, calls: d.calls, costUsd: d.costUsd }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      byAccount: (
        await Promise.all(
          [...accounts.entries()].map(async ([ownerId, a]) => {
            // One lookup per distinct account in the window, not per row.
            // A null user is an account that has since been deleted; its spend
            // is still real, so the row stays and only the label is missing.
            // The lookup itself is best-effort: an ownerId the auth component
            // can't decode (a redacted demo hash, a legacy value) must cost
            // the row its label, not take down the whole dashboard.
            let user = null;
            if (ownerId) {
              try {
                user = await authComponent.getAnyUserById(ctx, ownerId);
              } catch {
                user = null;
              }
            }
            return {
              account: ownerId ?? "Unattributed",
              name: user?.name || undefined,
              email: user?.email || undefined,
              calls: a.calls,
              costUsd: a.costUsd,
              promptTokens: a.promptTokens,
              completionTokens: a.completionTokens,
              errors: a.errors,
              documentsTouched: a.documents.size,
            };
          })
        )
      ).sort((a, b) => b.costUsd - a.costUsd),
    };
  },
});

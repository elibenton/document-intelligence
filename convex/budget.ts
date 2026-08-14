import { ConvexError, v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { adminMutation, adminQuery, authedQuery } from "./authz";

/**
 * The per-account spend cap.
 *
 * ## Where this is enforced, and why not at the API call
 *
 * The obvious place is `chatCompletion`, the single Interfaze chokepoint. It is
 * the wrong place: that function is pure — an API key, some options, and a
 * logger callback — with no `ctx` and so no database. Giving it one would mean
 * threading a Convex context through every helper in convex/interfaze.ts to
 * buy precision measured in cents.
 *
 * Instead the check sits at the points where a user *starts* work: uploading a
 * document, retrying a stage, running a search. The overshoot is therefore one
 * document's remaining pipeline — the stages already enqueued for it keep
 * running — which at the observed ~$0.07–0.54 per document is a rounding error
 * against a $10 ceiling, and it means a document already in flight finishes
 * rather than stranding half-processed.
 *
 * ## Why the ledger is its own table
 *
 * `apiLogs` cannot answer "what has this account spent" — `crons.ts` prunes it
 * after 30 days, so the sum silently shrinks over time. `userUsage.spentUsd` is
 * incremented in `apiLogs.record`, the one mutation every billable call passes
 * through, and is never pruned.
 *
 * ## The escape hatch is a row, not a deploy
 *
 * `limitUsd` is per account. Granting someone more is a single mutation, which
 * is what makes "reach out to me" a workable answer rather than a dead end.
 */

/** Default ceiling for a new account, in USD. */
export const DEFAULT_LIMIT_USD = 10;

/**
 * Thrown when an account is out of budget. A distinct `code` rather than a
 * message the UI has to string-match, because the UI has to render a specific
 * thing here — the request-more-credit path — and matching on prose breaks the
 * moment the prose is edited.
 */
export const BUDGET_EXHAUSTED = "budget_exhausted";

export type BudgetState = {
  spentUsd: number;
  limitUsd: number;
  exhausted: boolean;
};

export async function budgetFor(
  ctx: QueryCtx,
  userId: string
): Promise<BudgetState> {
  const row = await ctx.db
    .query("userUsage")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const spentUsd = row?.spentUsd ?? 0;
  const limitUsd = row?.limitUsd ?? DEFAULT_LIMIT_USD;
  return { spentUsd, limitUsd, exhausted: spentUsd >= limitUsd };
}

/**
 * Refuse to start new work for an account that is out of budget.
 *
 * Call this at the top of any endpoint that causes a paid API call, before the
 * work is enqueued. It throws, so the client's `useMutation` rejects and the
 * caller renders the out-of-credit state.
 */
export async function requireBudget(
  ctx: QueryCtx,
  userId: string
): Promise<BudgetState> {
  const budget = await budgetFor(ctx, userId);
  if (budget.exhausted) {
    throw new ConvexError({
      code: BUDGET_EXHAUSTED,
      spentUsd: budget.spentUsd,
      limitUsd: budget.limitUsd,
    });
  }
  return budget;
}

/** `requireBudget` for the authed actions, which have no `ctx.db`. */
export async function requireBudgetFromAction(
  ctx: ActionCtx & { user: { _id: string } }
): Promise<void> {
  await ctx.runQuery(internal.budget.assertWithinBudget, {
    userId: ctx.user._id,
  });
}

export const assertWithinBudget = internalQuery({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBudget(ctx, args.userId);
    return null;
  },
});

/**
 * Add a call's cost to an account's ledger, creating the row on first spend.
 *
 * Called from `apiLogs.record`, which has already resolved the owner. Unowned
 * calls — orphans, or anything logged before accounts existed — are skipped:
 * there is nobody to bill, and inventing a bucket for them would put spend on
 * an account that did not cause it.
 */
export async function chargeUsage(
  ctx: MutationCtx,
  userId: string | undefined,
  costUsd: number
): Promise<void> {
  if (!userId || !costUsd) return;
  const row = await ctx.db
    .query("userUsage")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (row) {
    await ctx.db.patch(row._id, {
      spentUsd: row.spentUsd + costUsd,
      updatedAt: Date.now(),
    });
  } else {
    await ctx.db.insert("userUsage", {
      userId,
      spentUsd: costUsd,
      updatedAt: Date.now(),
    });
  }
}

/** What the signed-in account has left, for the settings page and the banner. */
export const mine = authedQuery({
  args: {},
  returns: v.object({
    spentUsd: v.number(),
    limitUsd: v.number(),
    exhausted: v.boolean(),
  }),
  handler: async (ctx) => await budgetFor(ctx, ctx.user._id),
});

/**
 * Raise (or lower) an account's ceiling. The other half of "reach out to me":
 * an operator answering that request runs this rather than editing a constant
 * and redeploying.
 */
export const setLimit = adminMutation({
  args: { userId: v.string(), limitUsd: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.limitUsd < 0) throw new Error("A limit cannot be negative");
    const row = await ctx.db
      .query("userUsage")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        limitUsd: args.limitUsd,
        updatedAt: Date.now(),
      });
    } else {
      // An account that has not spent anything yet has no row. Create one so
      // the grant survives until they do.
      await ctx.db.insert("userUsage", {
        userId: args.userId,
        spentUsd: 0,
        limitUsd: args.limitUsd,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/** Every account's budget, for the admin dashboard's per-account table. */
export const allBudgets = adminQuery({
  args: {},
  returns: v.array(
    v.object({
      userId: v.string(),
      spentUsd: v.number(),
      limitUsd: v.number(),
      exhausted: v.boolean(),
    })
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("userUsage").collect();
    return rows.map((row) => ({
      userId: row.userId,
      spentUsd: row.spentUsd,
      limitUsd: row.limitUsd ?? DEFAULT_LIMIT_USD,
      exhausted: row.spentUsd >= (row.limitUsd ?? DEFAULT_LIMIT_USD),
    }));
  },
});

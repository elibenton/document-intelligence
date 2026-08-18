import {
  customAction,
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";

/**
 * The authenticated function builders. Every public endpoint in this directory
 * is built from one of these; a bare `query`/`mutation`/`action` export is by
 * definition an unauthenticated one.
 *
 * That is the point of the shape. There is no `requireUser(ctx)` helper to
 * remember to call, because `authComponent.getAuthUser` already throws on a
 * missing session — wrapping it in our own guard would be re-solving something
 * the component does. What was worth building is the part that makes a *missed*
 * endpoint visible, and this makes it greppable:
 *
 *     grep -rEn "^export const [a-zA-Z0-9_]+ = (query|mutation|action)\(" convex/
 *
 * which should match exactly one endpoint: `demo.startSession`, which cannot
 * take a session token because it is what issues one. (`auth.getAuthUser`, the
 * other endpoint that answers without a session, is a destructured re-export
 * and so was never matched by this grep in the first place — it is how the
 * client discovers it hasn't got a session.)
 *
 * `convex/ownership.test.ts` pins that list, so a second bare export cannot
 * appear quietly. Everything else in convex/demo.ts is built on `demoQuery` /
 * `demoMutation`, which resolve a `ctx.user` from that token and then walk the
 * same ownership helpers as the authed builders.
 *
 * `ctx.user` is the Better Auth user document, and is what phase 2's ownership
 * checks will read. Note its `_id` is a string from the component's tables, not
 * an `Id<"users">` — see docs/auth-plan.md §7.1.
 *
 * Internal functions deliberately keep the bare builders: Convex does not
 * propagate identity through the scheduler, so `ctx.auth` is null throughout
 * the processing pipeline. Ownership travels there as data (`projectId`), never
 * as identity.
 *
 * That has a second, sharper consequence, learned the hard way: **no module in
 * convex/ may reference `api.*`.** Seven pipeline call sites read
 * `api.documents.get` / `api.kinds.list` / `api.documentCategories.list`, and
 * `metadata` scheduled `api.processing.runRelationships`. Gating those made
 * every one of them throw Unauthenticated from inside the scheduler — silently,
 * because nothing awaits a scheduled function, so uploads simply stopped at
 * "Queued" with no error surfaced anywhere the user could see.
 *
 * Each now has an internal twin sharing one handler body. The invariant is a
 * grep, and it should stay empty:
 *
 *     grep -rn "\bapi\." convex/*.ts | grep -v _generated
 */
export const authedQuery = customQuery(
  query,
  customCtx(async (ctx: QueryCtx) => ({
    user: await authComponent.getAuthUser(ctx),
  }))
);

export const authedMutation = customMutation(
  mutation,
  customCtx(async (ctx: MutationCtx) => ({
    user: await authComponent.getAuthUser(ctx),
  }))
);

export const authedAction = customAction(
  action,
  customCtx(async (ctx: ActionCtx) => ({
    user: await authComponent.getAuthUser(ctx),
  }))
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * The owner. A constant rather than an env var on purpose: it lives in git, so
 * changing who can read everyone's spend is a reviewable diff rather than a
 * dashboard action, and it cannot skew between deployments the way the VITE_*
 * values in docs/auth-plan.md §4 can. `grep -rn ADMIN_USER_ID convex/` is the
 * whole audit. A second admin turns this into an array.
 *
 * A Better Auth user id and not the email address it belongs to. The email was
 * a *claim*: `convex/auth.ts` sets `requireEmailVerification: false`, so before
 * the account existed anyone who signed up as eliunited@gmail.com would have
 * been admin. An id cannot be claimed by signing up — and it could not be
 * written down until the account it names existed, which is why this landed
 * after the gate rather than with it (docs/admin-usage-plan.md §3.4).
 *
 * The trade is that this constant is now deployment-specific: the same email
 * signing up on a fresh deployment gets a different id, and admin there is
 * nobody until this is updated. That is the correct direction to fail.
 */
const ADMIN_USER_ID = "k17459c0gfmnejsavanan8gbg18cfxrg"; // eliunited@gmail.com

/**
 * Extends the sign-in check rather than restating it — same `getAuthUser` call,
 * one added condition.
 *
 * Composed here rather than as `customQuery(authedQuery, …)`. That does
 * typecheck (docs/admin-usage-plan.md §5.1 claims otherwise; it is wrong, and
 * was verified before this was written), but chaining the builders would run
 * two `getAuthUser` calls per request to answer one question.
 */
const adminOnly = customCtx(async (ctx: QueryCtx) => {
  const user = await authComponent.getAuthUser(ctx);
  if (user._id !== ADMIN_USER_ID) {
    throw new ConvexError("Not authorized");
  }
  return { user };
});

export const adminQuery = customQuery(query, adminOnly);

/**
 * The design change the comment above used to forbid, made deliberately.
 *
 * `adminQuery` was read-only on purpose, so that "the admin can look but not
 * touch" was enforced by which wrappers existed rather than by anyone
 * remembering. That held while the only admin surface was a usage dashboard.
 *
 * It stopped holding when the processing queue turned out to be shared
 * infrastructure. `setPaused` and `cancelWaiting` act on one processing queue
 * that every account's documents run through — pausing it stops everyone's
 * uploads, and cancel discards everyone's queued work. Those are operator
 * controls wearing a user control's clothes, and the honest fix is an operator
 * wrapper rather than leaving them reachable by anyone with a session.
 *
 * Keep this list short. A mutation belongs here only when it acts on something
 * shared by every account; anything scoped to one user's own data belongs on
 * `authedMutation` behind an ownership walk instead.
 */
export const adminMutation = customMutation(mutation, adminOnly);

/**
 * Whether the caller is the owner. Any signed-in user may ask; the answer is a
 * boolean, never the id — so the admin account is not a target published in the
 * client bundle.
 */
export const isAdmin = authedQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => ctx.user._id === ADMIN_USER_ID,
});

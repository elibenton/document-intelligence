import {
  customAction,
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
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
 * which should match nothing but `getAuthUser` in convex/auth.ts — the one
 * endpoint that has to answer without a session, since it is how the client
 * discovers it hasn't got one.
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
 * every one of them throw Unauthenticated from inside the workpool — silently,
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

import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

/**
 * The Better Auth component owns the user, session and account tables — they
 * live in the component's own namespace, not in convex/schema.ts. That is why
 * there is no `users` table here and no `onCreate` trigger mirroring one: the
 * component's record *is* the user record, reachable through
 * `authComponent.getAuthUser(ctx)`.
 *
 * The consequence for later ownership work: a foreign key to a user is a
 * `v.string()` holding the Better Auth id, never a `v.id("users")`.
 */
export const authComponent = createClient<DataModel>(components.betterAuth);

/**
 * `crossDomain` and CORS exist for `vite dev` only. In production the SPA is
 * served by @convex-dev/static-hosting from the same `.convex.site` origin
 * these routes are mounted on, so cookies are same-origin there; under
 * `vite dev` the app is on localhost:5173 and they are not.
 *
 * Email and password only, deliberately. Every other method completes through
 * a top-level navigation, which public/sw.js intercepts and caches as the app
 * shell — see docs/auth-plan.md §5. That guard lands before OAuth does.
 */
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = process.env.SITE_URL!;
  return betterAuth({
    baseURL: process.env.CONVEX_SITE_URL,
    // Both origins, always. CONVEX_SITE_URL is where static hosting serves the
    // deployed app from, so it has to be trusted or the hosted site cannot sign
    // anyone in; SITE_URL is the `vite dev` origin. Trusting only SITE_URL is
    // the shape of bug that works perfectly in dev and fails on deploy.
    trustedOrigins: [siteUrl, process.env.CONVEX_SITE_URL!],
    database: authComponent.adapter(ctx),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [crossDomain({ siteUrl }), convex({ authConfig })],
  });
};

/**
 * The component's own "who am I" query, re-exported as-is. This is the one
 * endpoint that must stay callable without a session — it is how the client
 * finds out it hasn't got one.
 */
export const { getAuthUser } = authComponent.clientApi();

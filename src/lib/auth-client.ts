import { createAuthClient } from "better-auth/react";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";

/**
 * Sign-in, sign-up and sign-out all run through here rather than through a
 * Convex mutation. They have to: Convex functions talk over a websocket, so
 * they can neither return an HTTP response nor set a cookie.
 *
 * `baseURL` is the deployment's `.convex.site` origin, which is also where
 * static hosting serves this app from in production — so the session cookie is
 * same-origin there. Under `vite dev` the app is on localhost and it isn't,
 * which is the only reason `crossDomainClient` is in this list.
 */
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_CONVEX_SITE_URL as string,
  plugins: [convexClient(), crossDomainClient()],
});

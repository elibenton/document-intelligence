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
 * which is the only reason `crossDomainClient` exists: it replays the session
 * from `localStorage` via a header because a cross-origin cookie won't ride
 * along. In production that would put the session token and Convex JWT in
 * `localStorage` — readable by any script — for no benefit, since prod is
 * same-origin and the HttpOnly cookie works. So the plugin is dev-only; the
 * cookie carries the session in the build users actually run.
 */
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_CONVEX_SITE_URL as string,
  plugins: [
    convexClient(),
    ...(import.meta.env.DEV ? [crossDomainClient()] : []),
  ],
});

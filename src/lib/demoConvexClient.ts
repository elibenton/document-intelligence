import { ConvexReactClient } from "convex/react";

/**
 * A second Convex client, for the landing page demo only.
 *
 * The app's own client is built with `expectAuth: true` (src/main.tsx), which
 * holds every query and mutation until a session resolves. That is correct for
 * the signed-in app — without it, gated queries fire once unauthenticated on
 * first paint and throw — but it is fatal for the demo, whose entire premise is
 * a visitor with no session at all. Requests from the demo sat in that queue
 * forever: the panel hung on "Checking the document…", and the deployment
 * logged zero demo calls because nothing ever reached the wire.
 *
 * The alternative was dropping `expectAuth` from the shared client, which would
 * hand the bug it exists to prevent back to every signed-in page in order to
 * fix one signed-out panel. A separate client keeps the two policies separate:
 * this one is never authenticated, and the endpoints it can reach are the five
 * in convex/demo.ts, which are unauthenticated by construction.
 *
 * Created on first use rather than at import, so the extra WebSocket is opened
 * only for a visitor who actually reaches the landing page.
 */
let client: ConvexReactClient | null = null;

export function demoConvexClient(): ConvexReactClient {
  client ??= new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
  return client;
}

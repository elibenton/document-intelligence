import type { Config } from "@react-router/dev/config";

/**
 * Framework mode without a server.
 *
 * `npm run deploy` is `@convex-dev/static-hosting` — a static CDN with no
 * per-request runtime — so `ssr: true` is not available and is not the point.
 * What this buys is route-based code splitting (the entry chunk was 1.36 MB
 * because App.tsx statically imported the pdf.js viewer), typed params, and a
 * route table that a later move to a real host turns on with this one flag.
 *
 * `ssr: false` also forces `routeDiscovery: { mode: "initial" }`, which inlines
 * the whole route manifest into the build. That is what makes this work on a
 * static host at all: the default `lazy` mode fetches a manifest from a server
 * endpoint that nothing here could serve.
 *
 * No `prerender` paths. `/` is ProjectsPage signed in and LandingPage signed
 * out, and that branch resolves in the browser, so prerendering it would emit
 * one of the two as a lie. The build emits root's Layout + HydrateFallback and
 * static hosting's extensionless-path fallback serves it for every route.
 */
export default {
  appDirectory: "src",
  ssr: false,
} satisfies Config;

# React Router framework mode (`ssr: false`) — plan

**Status:** steps 1–4 landed 2026-08-14; steps 5–7 (typed params, per-route
ErrorBoundary, preview deploy) still open. Verified against `react-router@8.3.0`
and `@react-router/dev@8.3.0`.

**Measured after the change:** initial JS for `/settings` is **649 KB**, down
from the **1339 KB** entry chunk. pdf.js, citeproc and the landing/demo bundle
are all off the eager path — confirmed by walking the static-import closure from
`entry.client` + `root` + `AuthGate` + `PageWithFooter` + `SettingsPage`.

This is **not** SSR. SSR needs a per-request JS runtime and `npm run deploy` is
`@convex-dev/static-hosting` — a static CDN. This plan keeps that deploy target
byte-for-byte and takes the parts of framework mode that work without a server:
route-based code splitting, typed params, per-route error boundaries, and a
route table that flips to `ssr: true` later as a config change rather than a
rewrite.

---

## 0. What this does not buy, so nobody is surprised

- **No server rendering, no SEO change.** With `ssr: false` and no `prerender`
  paths, the build emits one `index.html` containing root's `Layout` and its
  `HydrateFallback`. Route components render only after hydration. A crawler
  sees the same shell it sees today; the static `<meta>`/OG tags in
  `index.html` are what it reads, and they move verbatim into `root.tsx`.
- **No faster time-to-data.** `useQuery` is still a websocket subscription that
  opens after hydration. `clientLoader` runs in the browser too — it can't beat
  the socket.
- **The auth flash stays.** `<AuthLoading>` still gates first paint. It becomes
  root's `HydrateFallback` instead, which is tidier, not faster.
- **No loaders required.** `ssr: false` *rejects* a `loader` export on any
  non-prerendered route (`@react-router/dev/dist/vite.js:2400`), along with
  `action` and `headers`. `clientLoader` is available, but this plan adds none —
  every page keeps its `useQuery` calls exactly as written.

## 0.1 What it does buy

- **Code splitting.** `App.tsx:8` statically imports `DocumentPage`, whose chain
  reaches `src/lib/pdfDocument.ts:1` → `import * as pdfjs from "pdfjs-dist"`.
  That is why `dist/assets/index-*.js` is **1.36 MB** today, shipped to someone
  opening `/settings`. Framework mode lazily imports each route module, so
  pdf.js, `mediabunny`, `citeproc` and `papaparse` leave the entry chunk with no
  hand-written `React.lazy`.
- **Typed params.** `HomePage.tsx:358`, `EntityPage.tsx:20` and
  `DocumentPage.tsx:50` hand-annotate `useParams<{slug: string}>()`;
  `ProjectSettingsPage.tsx:20` doesn't, so its `slug` is `string | undefined`
  and nothing checks it against the route. `Route.ComponentProps` is generated
  from `routes.ts`, so a renamed segment becomes a type error.
- **A real 404.** Signed in, an unmatched path currently matches nothing and
  paints blank (`App.tsx:81-116` has no `*` route inside `<Authenticated>`).
- **Per-route `ErrorBoundary`.** `/admin` is gated server-side by `adminQuery`
  and a non-admin "gets a thrown error, which is the correct outcome"
  (`App.tsx:92`). Today that error has nowhere to land.

---

## 1. The one real structural change: the auth split

`App.tsx` has **two** `<Routes>` trees with overlapping paths — `/signin` means
different things inside `<Unauthenticated>` and `<Authenticated>`. `routes.ts`
is a single static table, so the branch has to move from *which table matches*
to *what a layout renders*.

Behaviour to preserve exactly:

| State | Path | Today |
| --- | --- | --- |
| loading | any | centred `<Spinner/>`, nothing else |
| signed out | `/signin`, `/signup` | those pages |
| signed out | any other path | `LandingPage`, **URL preserved, no redirect** |
| signed in | `/signin`, `/signup` | `<Navigate to="/" replace/>` |
| signed in | app paths | the pages, `UploadProvider` + 3 banners above them |

### 1.1 `src/routes.ts`

```ts
import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // AuthLoading → Spinner; Unauthenticated → LandingPage; Authenticated →
  // UploadProvider + banners + <Outlet/>. Being the common parent of both
  // branches below is load-bearing: it keeps upload state alive across
  // navigations in and out of the viewer, which App.tsx:70-75 relies on today.
  layout("layouts/AuthGate.tsx", [
    layout("layouts/PageWithFooter.tsx", [
      index("pages/ProjectsPage.tsx"),
      route("p/:slug", "pages/HomePage.tsx"),
      route("p/:slug/settings", "pages/ProjectSettingsPage.tsx"),
      route("entity/:slug", "pages/EntityPage.tsx"),
      route("search", "pages/SearchPage.tsx"),
      route("settings", "pages/SettingsPage.tsx"),
      route("admin", "pages/AdminPage.tsx"),
    ]),
    // Fixed-height workspace, no footer — outside the shell, as today.
    route("documents/:id", "pages/DocumentPage.tsx"),
    // Signed out this never renders: AuthGate paints LandingPage first, which
    // is exactly the `path="*"` behaviour of App.tsx:66.
    route("*", "pages/NotFoundPage.tsx"),
  ]),
  // Signed in these redirect to "/", as App.tsx:108-115 does.
  layout("layouts/SignedOutOnly.tsx", [
    route("signin", "pages/SignInPage.tsx"),
    route("signup", "pages/SignUpPage.tsx"),
  ]),
] satisfies RouteConfig;
```

`appDirectory` is set to `"src"`, so these paths are relative to `src/` and
**no page file moves**. `AuthGate` and `SignedOutOnly` are new; `PageWithFooter`
is lifted out of `App.tsx:25-34` unchanged.

### 1.2 `AuthGate` must import `LandingPage` lazily — this is not optional

`LandingPage.tsx:3` imports `DemoPanel`, which reaches `DemoPages.tsx:2` →
`usePdfDocument` → `pdfjs-dist`. **The landing page contains pdf.js**, and it
should: the demo's whole argument is that the dropped file paints before the
server has done anything (`DemoPages.tsx:8-13`), which requires pdf.js to be in
the browser at drop time. That trade is correct and this plan does not touch it.

But `AuthGate` renders `LandingPage` for the signed-out branch, and a layout's
static imports land in a chunk that **every route under it downloads**. A plain
`import LandingPage from "../pages/LandingPage"` there would put pdf.js back
into the shared chunk and cancel §0.1 entirely — the migration would move the
1.36 MB rather than shrink it.

So the gate uses a lazy boundary:

```tsx
const LandingPage = lazy(() => import("../pages/LandingPage"));
// …
<Unauthenticated>
  <Suspense fallback={<Spinner />}>
    <LandingPage />
  </Suspense>
</Unauthenticated>
```

A hand-written `lazy` inside a layout is the one thing framework mode would
normally remove, and it survives here because the signed-out branch genuinely is
not expressible in a static route table — it has to render at *any* URL with the
URL preserved (`App.tsx:63-65`). Worth a comment saying so.

The signed-in viewer reaches pdf.js through its own route module
(`documents/:id`), so both paths load it on demand and Rollup gives them one
shared chunk.

### 1.3 What the demo needs from this migration: nothing

Checked, because it runs on exactly the path `AuthGate` is new code for:

- **Its own Convex client is already prerender-safe.** `demoConvexClient()`
  (`src/lib/demoConvexClient.ts:23-28`) is created on first call, not at import —
  deliberately, per its own comment. It does not add a second instance of the
  §2.1 hazard.
- **`localStorage` access is already guarded.** Every accessor in
  `src/lib/demoSession.ts` wraps `window.localStorage` in `try/catch` for Safari
  private mode, which also means it returns `null` under Node during the
  build-time prerender instead of throwing.
- **The nested `<ConvexProvider client={demoConvexClient()}>` in
  `DemoPanel.tsx:104` keeps working unchanged** inside root's
  `ConvexBetterAuthProvider`.
- **`convex/demoLimits.ts` imported from `src/`** still resolves; `appDirectory:
  "src"` does not change relative import resolution.

Nothing to port. The risk is regression, not redesign — see §6.

`App.tsx` is deleted. The `<main id="main">` wrapper around `DocumentPage`
(`App.tsx:102`) moves inside `DocumentPage.tsx` as its own root element.

---

## 2. Entry points

`main.tsx` and `index.html` are both deleted; their contents split three ways.

**`src/root.tsx`**

- `Layout` — the `<html>`/`<head>`/`<body>` skeleton with `<Meta/>`, `<Links/>`,
  `<ScrollRestoration/>`, `<Scripts/>`. Everything currently literal in
  `index.html` moves here: the icons, manifest, canonical, Apple standalone tags,
  `theme-color` pair, OG and Twitter blocks, and the inline
  `localStorage.getItem("di-theme")` bootstrap (as
  `<script dangerouslySetInnerHTML>` — it must stay inline and before paint, and
  must stay in sync with `THEME_STORAGE_KEY` in `src/lib/theme.tsx:15`).
- `HydrateFallback` — the centred `<Spinner/>` from `App.tsx:53-57`. This is
  what the prerendered `index.html` actually contains.
- default export — `ThemeProvider` → `ConvexBetterAuthProvider` →
  `TooltipProvider` → `ToastProvider` → `ConfirmProvider` → skip-link →
  `<div className="min-h-screen …">` → `<Outlet/>`. No `<BrowserRouter>`;
  framework mode owns the router.

Root must not export a `loader`.

**`src/entry.client.tsx`** — the default is fine; add one only for the service
worker registration from `main.tsx:35-39`.

**No `entry.server.tsx`** — the default handles the build-time prerender of the
shell.

### 2.1 Known hazard: the Convex client at module scope

`main.tsx:28` constructs `new ConvexReactClient(...)` at import time. In SPA
mode the root module is *imported and rendered in Node at build time* (only
`Layout` + `HydrateFallback` render, but the whole module evaluates). If that
construction touches a browser global or opens a socket, the build breaks.

**Settled: it is fine.** `react-router build` completes with the client
constructed at module scope in `root.tsx`, so no hoist is needed and the
idiomatic Convex shape survives. If this ever regresses, the mitigation is
`useState(() => new ConvexReactClient(...))` in the default component.

The `import.meta.env.PROD` assertion on `VITE_CONVEX_SITE_URL` (`main.tsx:17-24`)
*should* stay at module scope. It currently throws in the user's browser; after
this change it throws during `react-router build`, which is where a build-time
env mistake belongs. That is a small free win.

---

## 3. Config

**`react-router.config.ts`** (new)

```ts
import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "src",
  ssr: false,
} satisfies Config;
```

No `prerender`. With `ssr: false` the dev plugin forces
`routeDiscovery: { mode: "initial" }` (`vite.js:3482`), so the full route
manifest is inlined and nothing ever fetches a `/__manifest` endpoint — which a
static host could not serve. That is the detail that makes this work at all.

**`vite.config.ts`** — add `reactRouter()` from `@react-router/dev/vite`, before
`tailwindcss()`. Drop `@vitejs/plugin-react` (the RR plugin supplies it).

**`package.json`**

```json
"dev": "react-router dev",
"build": "react-router typegen && tsc -b && react-router build",
"deploy": "npx @convex-dev/static-hosting deploy --dist ./build/client"
```

`--dist` (default `./dist`) is a real flag — `dist/cli/args.js:26`. Build output
moves to `build/client/`. Static hosting's SPA fallback ("paths without an
extension fall back to `index.html`", per its README) is what serves `/p/:slug`
and `/documents/:id`, and is unchanged by this.

**`tsconfig.app.json`** — `"include": ["src", ".react-router/types/**/*"]` and
`"rootDirs": [".", "./.react-router/types"]`.

**`eslint.config.js:11`** — `globalIgnores(['dist', 'build', '.react-router',
'convex/_generated'])`. Also add `allowExportNames` for `meta`, `links`,
`clientLoader`, `ErrorBoundary`, `HydrateFallback` to `reactRefresh.configs.vite`,
or every route module trips `react-refresh/only-export-components`.

**`public/sw.js:7`** — `SHELL` still lists `/`, still correct.

---

## 4. The pdf.js plugin

`pdfjsAssets()` (`vite.config.ts`) is the one piece that needs real care.

- `configureServer` — unchanged; `react-router dev` is still a Vite dev server.
- `generateBundle` — framework mode builds more than one Vite environment, so
  this fires more than once and would emit the four directories into each
  output. Guard it with `if (this.environment.name !== "client") return;`
  (Vite 7 environment API, already the installed version).

Its comment about content hashing still holds: pdf.js appends its own filenames
to directory URLs, so these stay unhashed at `/pdfjs/` in both dev and build.

**Verification for this step specifically:** after `react-router build`, confirm
`build/client/pdfjs/{wasm,cmaps,standard_fonts,iccs}` each exist exactly once,
then open a JPEG 2000 scan in the viewer — a missing decoder fails as a console
warning and a blank white page, not an error.

---

## 5. Order of work

Each step should build and run before the next.

1. Install `@react-router/dev@8.3.0`; add `react-router.config.ts` and the
   `vite.config.ts` plugin. Nothing else. Build fails — expected, no `routes.ts`.
2. `src/root.tsx` + `src/routes.ts` with **one** route (`index` → ProjectsPage)
   and no auth gate. Prove the shell, the theme bootstrap, and hydration.
   Delete `index.html`. This is where §2.1 gets settled.
3. Add `AuthGate`, `SignedOutOnly`, `PageWithFooter`; fill in the route table;
   delete `App.tsx` and `main.tsx`.
4. Fix the pdf.js plugin guard; update the deploy `--dist`, tsconfig, eslint.
5. Convert the four `useParams` sites to `Route.ComponentProps`.
6. Add `NotFoundPage` and an `ErrorBoundary` on the `/admin` route.
7. Deploy to a preview deployment before prod.

Rough size: steps 1–4 are the work, and they are half a day if §2.1 behaves.
Steps 5–7 are an hour.

---

## 6. Verification

Beyond `npx tsc -b` and `npm run lint`, which only catch the import rules:

- **Auth matrix.** Walk all five rows of the §1 table. In particular: signed out,
  paste `/documents/<id>` and confirm the URL stays and LandingPage renders
  (a redirect here is a regression, per `App.tsx:63-65`).
- **Upload state across navigation.** Start an upload on `/p/:slug`, open a
  document, come back. If the progress is gone, `AuthGate` is in the wrong place.
- **Keyboard.** Per CLAUDE.md, anything interactive is unverified until driven
  Tab / Shift-Tab / Enter / Escape with the focus ring visible at every stop and
  focus restored to the trigger on close. The skip-link moved; check it first.
- **The demo, end to end, signed out.** This is the highest-risk surface in the
  whole migration: it is unauthenticated, it has its own Convex client, and
  `AuthGate` is brand-new code sitting directly in front of it. Drop a real PDF
  and confirm, in order — the pages paint from the blob URL *before* any result
  arrives (`DemoPages.tsx:8-13`); the results fill in beside them; a reload
  restores both from the stored token (`demoSession.ts:5-10`); and a second file
  is refused with the already-used state. Then check each refusal path —
  oversized, too many pages, wrong type — still renders its own message rather
  than the generic one.
- **Bundle.** `ls -laS build/client/assets | head` against the 1.36 MB baseline.
  If the entry chunk is still over a megabyte, a route module is being statically
  imported by a layout. Specifically confirm `pdfjs` is **not** in the chunk that
  `/settings` loads — that is the §1.2 failure mode, and it is silent.
- **Deploy.** Hard-reload `/p/<slug>` and `/documents/<id>` on the deployed URL
  to exercise SPA fallback, not just client-side navigation.

---

## 7. The door this leaves open

If the calculus ever changes and a Node/edge host becomes acceptable, `ssr: false`
→ `ssr: true` is a one-line change against a route table that is already correct.
The remaining work at that point is the part that has no shortcut and is
unchanged by this plan: a React Router adapter for `@convex-dev/better-auth`,
which ships `nextjs` and `react-start` only — its `react-start` `getToken` reads
request headers via `await import("@tanstack/react-start/server")`
(`dist/react-start/index.js:63`), which is exactly the framework-coupled seam.
Plus `fetchQuery`-in-`loader` for whichever of the 64 `useQuery` call sites are
worth server-rendering. Doing this plan now does not add to that bill; it just
stops it from also including the route table.

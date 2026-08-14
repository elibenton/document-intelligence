# Authentication — plan

**Status:** proposed. Nothing built.

Add real authentication via the Convex Better Auth component, in two phases
that ship independently:

- **Phase 1 — the gate.** Nobody but a logged-in user can call anything. No
  schema change, no backfill, no ownership model.
- **Phase 2 — ownership.** Rows belong to a user; a logged-in user sees only
  their own projects.

Phase 1 removes the entire current risk surface. Phase 2 only becomes
meaningful when there is a second user, and is deliberately deferred until
then.

---

## 0. What is *not* in scope, and why

- **Sharing, teams, invitations, roles.** A `projectMembers` table with an
  invite flow is the natural phase 3, and designing it now — before anyone has
  been invited to anything — is the speculative generality CLAUDE.md warns
  about. Phase 2 stops at single-owner.
- **A global app header.** The landing page gets its own header for its two
  auth buttons (§3.4). Giving the six signed-in pages a shared top bar to hold
  a user menu is a design change across all of them, not something auth
  requires; sign-out goes in an existing surface instead.
- **Gating the static site.** `@convex-dev/static-hosting` has no hook to
  require a session before serving `index.html`, and non-HTML assets are 302'd
  to a public `/fs/blobs/<id>` URL. The app shell stays world-readable. This is
  normal for an SPA — the data is behind the functions, not behind the bundle —
  but it means "add auth" never hides the deployment URL or the function names.
- **Re-scoping the global taxonomy tables.** `documentCategories`,
  `documentKinds` and `appSettings` are deployment-wide today.
  `project-profiles-plan.md` already plans to project-scope the first two.
  This plan does not touch them; see §7.3 for the ordering constraint between
  the two efforts.
- **Replacing the `/clip` shared secret.** See §8 — it is a real decision, but
  it is separable and does not block either phase.

---

## 1. What exists today

Verified, not assumed:

| Fact | Evidence |
| --- | --- |
| No auth of any kind | No `convex/auth.config.ts`; zero `ctx.auth` references in `convex/` or `src/` |
| 83 public endpoints | 45 `query`, 32 `mutation`, 5 `action`, 1 bare `mutation`, across 28 files |
| 68 internal functions | 42 `internalMutation`, 16 `internalQuery`, 10 `internalAction` — already unreachable |
| Deployment URL is public | `https://glorious-warbler-976.convex.cloud` appears in plaintext in `dist/assets/index-*.js` |
| Function paths are public | `me.processing.runAnalyze`, `me.upload.generateUploadUrl`, `me.processing.runFullPipeline` likewise |
| One existing auth mechanism | `CLIPPER_API_KEY` bearer check on `POST /clip` (`convex/http.ts`) |
| `projects` is the tenancy root | 6 tables carry `projectId`; the rest hang off `documents` or `entities` |

The endpoint count by file, which is the phase 1 work list:

```
9 documents      5 documentCategories   3 mergeSuggestions   2 pages
7 projects       4 search               3 processingControl  2 pageImages
6 entities       4 roles                3 projectEntityTypes 2 apiLogs
5 processing     4 blocks               2 translations       1 transcripts
                 4 annotations          2 settings           1 providerHealth
3 upload                                2 relationships      1 metadata
                                        2 projectViews       1 kinds
                                        2 processingJobs     1 embeddings
                                                             1 detections
                                                             1 analyzePrompt
```

### 1.1 What the gap actually costs

Ranked by how much damage an unauthenticated caller can do:

1. **Unbounded Interfaze spend.** `processing.runAnalyze`, `runFullPipeline`,
   `runTranscription`, `runRelationships`, `retryBlocked`, `translations.retry`
   and `search.start` all bill real money — $0.0308 per Analyze, $0.066 per
   full pipeline. Public queries hand out the document IDs to loop over. The
   workpool bounds *concurrency*, not total spend.
2. **`settings.updateDefaultLanguage`** bumps `translationVersion` and schedules
   a translation backfill across every document — one call, a large bill.
3. **Destructive mutations.** `projects.remove` cascades; `documents.remove`,
   `mergeSuggestions.accept`, `blocks.updateType`, `documentCategories.remove`
   have no confirmation and no undo.
4. **Arbitrary storage writes.** `upload.generateUploadUrl` is a bare public
   mutation returning a signed URL. Any bytes, any size, billed to us.
5. **Full read access** to document text, pages, entities, relationships,
   annotations and extracted metadata.

Discovery requires knowing the deployment name, so this is low-probability —
but the downside has no floor, which is the whole argument for phase 1.

---

## 2. Phase 1 — the gate

### 2.1 Packages

```bash
npm install @convex-dev/better-auth better-auth@~1.6.15 convex-helpers
```

`@convex-dev/better-auth@0.12.5` requires `convex@^1.25` (we are on 1.33) and
pins `better-auth` to `>=1.6.11 <1.7.0`. It is still labelled early alpha, and
without a "local install" the component's own schema is fixed and cannot be
altered.

`convex-helpers` arrives transitively via the component's CORS router; §2.5
uses it directly, so it becomes a direct dependency.

### 2.2 Register the component

`convex/convex.config.ts` — additive, nothing existing moves:

```ts
import betterAuth from "@convex-dev/better-auth/convex.config";
app.use(betterAuth);
```

### 2.3 Auth config and server instance

`convex/auth.config.ts`:

```ts
import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

export default { providers: [getAuthConfigProvider()] } satisfies AuthConfig;
```

`convex/auth.ts`:

```ts
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

const siteUrl = process.env.SITE_URL!;

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: process.env.CONVEX_SITE_URL,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [crossDomain({ siteUrl }), convex({ authConfig })],
  });

// The component's own query, exposed as-is. Do not hand-roll a "current user"
// query beside it.
export const { getAuthUser } = authComponent.clientApi();
```

**Start with email + password.** It is the only method that never triggers a
top-level navigation, which sidesteps §5 entirely until we choose to deal with
it. OAuth is a later, separate commit.

**No app-side `users` table, and no `onCreate` trigger.** The component owns
the user record; `authComponent.getAuthUser(ctx)` returns it. An app-side
mirror buys nothing until we have user-specific app data to store, and the
component's `triggers` option additionally requires declaring `authFunctions`,
which is machinery we would be carrying for no reader.

### 2.4 HTTP routes

`convex/http.ts` — one line added above the existing `registerStaticRoutes`
call:

```ts
authComponent.registerRoutes(http, createAuth, { cors: true });
```

**Ordering does not matter, despite appearances.** Convex's router matches
exact paths first, then prefixes sorted longest-first
(`convex/dist/esm/server/router.js`), so Better Auth's `/api/auth/` beats
static hosting's `/` catch-all regardless of registration order. The existing
`/clip` routes are exact paths and are unaffected; the component's CORS router
scopes its `OPTIONS` route to `/api/auth/`, so it does not collide with the
hand-rolled `OPTIONS /clip`.

Placing it above `registerStaticRoutes` anyway, because that is the order
static hosting's own docs show.

### 2.5 The gate itself — `convex/authz.ts`

`authComponent.getAuthUser(ctx)` already throws when unauthenticated, so there
is nothing to write that decides *whether* to reject. What is worth writing is
the wiring that stops us having to remember, built on `customFunctions` rather
than a bespoke wrapper:

```ts
import { customQuery, customMutation, customAction }
  from "convex-helpers/server/customFunctions";
import { query, mutation, action } from "./_generated/server";
import { authComponent } from "./auth";

const authed = {
  args: {},
  input: async (ctx: any) => ({ ctx: { user: await authComponent.getAuthUser(ctx) }, args: {} }),
};

export const authedQuery = customQuery(query, authed);
export const authedMutation = customMutation(mutation, authed);
export const authedAction = customAction(action, authed);
```

Then each of the 83 endpoints changes by one word at the import, and the
handler gains `ctx.user` for free:

```ts
- import { query, mutation } from "./_generated/server";
+ import { authedQuery, authedMutation } from "./authz";

- export const list = query({
+ export const list = authedQuery({
```

The reason this shape and not 83 inserted `await requireUser(ctx)` lines: it
makes completeness **greppable**. After the pass, any surviving
`= query(` / `= mutation(` / `= action(` in `convex/` is an unguarded endpoint,
which is a one-command audit and a candidate eslint rule later — the same fence
pattern `src/components/ui/` already uses.

`getAuthUser` in `convex/auth.ts` is the one intentional exception: it comes
from `clientApi()` and must stay public so the client can ask "am I logged in?"

### 2.6 What phase 1 does *not* change

- **The 68 internal functions keep bare `internalQuery`/`internalMutation`/
  `internalAction`.** They were never reachable. More importantly, Convex does
  not propagate identity through the scheduler, so `ctx.auth` is `null` inside
  the entire processing pipeline (workpool → scheduler → internal action).
  Gating them would break the pipeline and protect nothing.
- **Ownership travels as data, not as identity.** `documents.projectId` already
  does this. Nothing about the pipeline needs to change in phase 1 or phase 2.

---

## 3. Frontend

### 3.1 Client and provider

`src/lib/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/react";
import { convexClient, crossDomainClient }
  from "@convex-dev/better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_CONVEX_SITE_URL,
  plugins: [convexClient(), crossDomainClient()],
});
```

`src/main.tsx` — `ConvexProvider` becomes `ConvexBetterAuthProvider`, and the
client gains `expectAuth: true` so queries hold until auth resolves rather than
firing unauthenticated and throwing:

```ts
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string, {
  expectAuth: true,
});

<ConvexBetterAuthProvider client={convex} authClient={authClient}>
```

The existing `ThemeProvider` / `BrowserRouter` nesting is unchanged.

### 3.2 Public landing page, private app

`/` is currently `ProjectsPage`. It becomes the one **public** route: a landing
page for logged-out visitors, with sign-up and log-in in the top right.

| Path | Public | Logged out | Logged in |
| --- | --- | --- | --- |
| `/` | yes | `LandingPage` | `ProjectsPage` (unchanged) |
| `/signin`, `/signup` | yes | the forms | redirect to `/` |
| `/p/:slug`, `/entity/:slug`, `/search`, `/settings`, `/documents/:id` | no | redirect to `/signin` | unchanged |

**`/` swaps by auth state rather than moving the app to `/app`.** Existing
bookmarks and links keep working, there is no redirect flash on every visit for
a signed-in user, and `Authenticated` / `Unauthenticated` express the swap
directly:

```tsx
<Route
  path="/"
  element={
    <>
      <AuthLoading><AppSkeleton /></AuthLoading>
      <Unauthenticated><LandingPage /></Unauthenticated>
      <Authenticated><ProjectsPage /></Authenticated>
    </>
  }
/>
```

Everything else stays inside a single `<Authenticated>` boundary. `AuthLoading`
is not optional garnish — without it, the first paint of a reload renders the
logged-out branch for a moment and a signed-in user sees the landing page flash
before their projects.

### 3.3 The trap: four components mounted outside `<Routes>`

`ProcessingBlockerBanner`, `ProcessingQueueBanner`, `GlobalDropOverlay` and
`UploadProvider` sit **outside** the `<Routes>` block in
[App.tsx:34-46](src/App.tsx:34), so they render on every route. All four call
`useQuery` on endpoints that phase 1 gates:

| Component | Gated query |
| --- | --- |
| `ProcessingQueueBanner` | `api.processingControl.get` |
| `ProcessingBlockerBanner` | `api.documents.processingBlocker` |
| `GlobalDropOverlay` | `api.documents.get`, `search`, `entities`, `projects` |
| `UploadProvider` | `api.documents.ingestStates` |

A public landing page is therefore **not** just a new `<Route>`. As the file
stands today, a logged-out visitor to `/` mounts all four and fires five gated
queries that throw before the landing page paints.

They all move inside the `<Authenticated>` boundary, which is where they belong
anyway — a drop-to-upload overlay and a processing-queue banner have no meaning
without a session. `TooltipProvider`, `ToastProvider` and `ConfirmProvider` are
pure UI context and stay at the top.

This is the single most likely way to ship a landing page that white-screens,
so it is called out here rather than discovered at runtime.

### 3.4 New UI

Three new pages, all built from `src/components/ui/` primitives per CLAUDE.md —
no hand-rolled form, focus or dialog behavior:

- **`src/pages/LandingPage.tsx`.** Its own header, since there is no shared one
  (see below): product name left, **Log in** (ghost) and **Sign up** (primary)
  top right. Body is a one-line description of what the app does and a primary
  call to action. Deliberately minimal — this is a door, not a marketing site,
  and every element added here is one nobody asked for.
- **`src/pages/SignInPage.tsx`** and **`SignUpPage.tsx`.** Email, password,
  submit, error. Cross-links to each other.

**There is no shared header to hang the buttons on.** `PageShell` has an
`actions` slot, but it is per-page, and `DocumentPage` and `SearchPage` roll
their own headers outside it. So the landing page brings its own header, and
**sign-out goes in `SettingsPage` or `SiteFooter`** — both already render on
every signed-in page. Introducing a global app header to hold a user menu is a
real design change affecting all six pages; it is not required by auth and is
out of scope here.

Note the component's own constraint: sign-in/up/out **must** be driven from the
client via `authClient.signIn.*` / `signUp.*` / `signOut()`, because Convex
functions run over websockets and cannot set cookies. There is no server-side
sign-in mutation to write.

Since `/` is now the only page an unauthenticated visitor — or a link
preview, or a crawler — ever sees, it is also what `og-image.png` and
`site.webmanifest` in `public/` are describing. Worth a look while editing it;
no work is currently planned there.

---

## 4. Environment and deploy

| Variable | Where | Dev | Prod |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | Convex env | `openssl rand -base64 32` | separate value |
| `SITE_URL` | Convex env | `http://localhost:5173` | `https://<deployment>.convex.site` |
| `VITE_CONVEX_SITE_URL` | **baked into bundle** | `.convex.site` URL | same |

The framework guide also lists `VITE_SITE_URL`. Nothing here reads it —
`auth-client.ts` needs only the `.convex.site` origin — so it is not set.

**The footgun.** `SITE_URL` and `BETTER_AUTH_SECRET` are read at runtime from
the deployment; the two `VITE_*` values are compiled into the bundle by Vite at
build time. Since `npm run deploy` publishes a *pre-built* bundle and is
entirely separate from `npx convex dev`, it is possible to ship a production
bundle pointing at `localhost:5173` that works perfectly in dev and fails only
in production. Today `src/main.tsx` reads only `VITE_CONVEX_URL`, so this is
new surface.

Mitigation: assert both `VITE_*` values are non-empty and non-localhost at
module load when `import.meta.env.PROD`, and fail the build loudly rather than
shipping a broken login.

### 4.1 Origins

Production is **same-origin** — the SPA and the auth endpoints are both
`<deployment>.convex.site` — so cookies work natively there. Dev is
cross-origin (`localhost:5173` → `.convex.site`), which is the only reason
`crossDomain` and `{ cors: true }` are in the config at all. Carrying them
permanently for a dev-only condition is the accepted cost.

---

## 5. The service worker

`public/sw.js` intercepts every same-origin `GET` navigation, network-first,
and caches the response under the key `/`:

```js
caches.open(CACHE).then((cache) => cache.put("/", copy));
```

Because production is same-origin, an OAuth callback, an email-verification
link, or a magic link arrives as exactly such a navigation to
`/api/auth/callback/...`. In the happy path the followed response is the real
shell and this is benign; on the error path an auth error response gets cached
as the app shell and served on the next offline navigation.

Email + password never triggers it (that path is `fetch`, not a navigation),
which is why §2.3 starts there. The fix is one guard at the top of the `fetch`
handler:

```js
if (new URL(request.url).pathname.startsWith("/api/auth/")) return;
```

Land this **in the same commit as the component**, before any OAuth provider is
ever tested — not after debugging it.

---

## 6. Verification

Per CLAUDE.md, keyboard-first, and none of it is optional:

- `npx tsc -b` clean; `npm run lint` still exactly 2 pre-existing errors in
  `src/components/viewer/`.
- `grep -rEn "^export const [a-zA-Z0-9_]+ = (query|mutation|action)\(" convex/`
  returns only `auth.ts`'s `getAuthUser`. This is the phase 1 completeness
  check.
- Landing, sign-in and sign-up pages driven Tab / Shift-Tab / Enter / Escape,
  focus ring visible at every stop, including the two top-right buttons.
- **Logged out, load `/` with the console open.** Zero errors and zero gated
  queries in the network tab — this is the §3.3 regression check, and it is the
  one that will actually fail first.
- Logged in, `/` still renders `ProjectsPage`, and a hard reload does not flash
  the landing page before it.
- Logged out, `curl` one endpoint of each kind directly against
  `.convex.cloud` and confirm rejection — the gate is server-side, and testing
  it only through the UI proves nothing.
- Upload → full pipeline → rename → extract still completes end to end. This is
  the regression that matters: it proves the scheduler path was not gated by
  accident.

---

## 7. Phase 2 — ownership

Deferred until there is a second user. Recorded now so phase 1 does not paint
us into a corner.

### 7.1 The key constraint

The user record lives in the **component's** tables, not ours. There is no
`users` table in `convex/schema.ts` to point at, so an owner field is
`v.string()` holding the Better Auth user id — **not** `v.id("users")`. Getting
this wrong is the most likely phase 2 mistake.

### 7.2 Single owner on the root

`projects` is the tenancy root and `documents.projectId` already exists, so the
minimum viable model is one field:

```ts
projects: defineTable({ ..., ownerId: v.optional(v.string()) })
  .index("by_owner", ["ownerId"])
```

Every check becomes a walk up to a project: leaf row → `documentId` →
`projectId` → `project.ownerId`. At most two `ctx.db.get` calls. Denormalising
`ownerId` onto all 24 tables would be faster and would drift; not worth it at
this size.

### 7.3 The blocking prerequisite

Four tables carry `projectId` as **optional** — `documents`, `entities`,
`annotations`, `searches` — because rows predate projects. An ownership walk
that hits `undefined` has no defined answer, so these must be backfilled and
narrowed to required *before* the walk can be trusted.

That is the widen → migrate → narrow dance, three deploys per table, and it is
the same work `project-profiles-plan.md` needs. **These two efforts should be
sequenced together**, with the backfill done once, rather than each plan
migrating the same rows separately.

House pattern for the migration: a self-rescheduling paginated
`internalMutation` in `convex/migrations.ts`, matching
`backfillEntitySlugs` — not a new `@convex-dev/migrations` dependency.

### 7.4 Then

`authedQuery`/`authedMutation` from §2.5 grow an ownership assertion, or gain
`ownedQuery` siblings that take the id argument and do the walk. Deciding which
is a phase 2 question and does not need answering now.

---

## 8. `/clip`

Unchanged by either phase. `CLIPPER_API_KEY` is a deployment-wide shared secret
with no user attached, which is correct while there is one user and wrong the
moment there are two. When phase 2 lands, the options are a per-user key
checked against a new table, or a Better Auth session cookie from the
extension. Not a blocker; flagged so it is not forgotten.

---

## 9. Sequencing

Atomic commits, straight to `main`.

| # | Commit | Notes |
| --- | --- | --- |
| 1 | Install the component; `convex.config.ts`, `auth.config.ts`, `auth.ts`, `http.ts` route; sw.js guard | Nothing gated yet; app still works logged out |
| 2 | Provider swap in `main.tsx`; sign-in + sign-up pages | Login works; endpoints still open |
| 3 | Landing page; move the four always-mounted components inside `<Authenticated>`; route table from §3.2 | Do this **before** gating, so §3.3 surfaces while endpoints are still open and the failure is visible rather than masked |
| 4 | `convex/authz.ts` | The wrapper, no call sites changed yet |
| 5..n | Gate endpoints, a few files at a time | Each commit ships; `documents`/`projects`/`processing`/`upload` first — that is most of §1.1 |
| n+1 | Prod env vars + build-time assertion, deploy | The `VITE_*` footgun |
| — | *(optional)* OAuth provider | Only after the §5 sw.js guard has shipped |
| — | *(phase 2, later)* backfill `projectId`, narrow, add `ownerId` | Sequence with `project-profiles-plan.md` |

Commit 3 is where the real risk closes. If the full 83-endpoint pass stalls,
gating just `processing.*`, `settings.updateDefaultLanguage`,
`upload.generateUploadUrl`, `projects.remove`, `documents.remove` and
`translations.retry` removes every unbounded-downside item in §1.1 in well
under an hour.

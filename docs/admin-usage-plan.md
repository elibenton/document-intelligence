# Admin usage dashboard — plan

**Status:** built. Stage A and Stage B have both shipped, along with the §3.4
follow-up pinning the admin to a user id. Stage B's per-account breakdown was
added to the existing `usage` query rather than a second `usageByAccount` one,
so the 5,000-row window is scanned once per subscription instead of twice.

One account (`eliunited@gmail.com`) gets a read-only view of what the deployment
is spending and, later, how that spend splits across accounts. It must not
become a back door into anyone else's documents.

The whole design turns on one sentence: **`adminQuery` grants no database access
that `authedQuery` did not already grant.** Convex has no row-level security.
The admin's elevated capability is not "can read more rows" — it is "can call
three extra endpoints that return only numbers". Every control below exists to
keep that true as the file grows.

---

## 0. What is *not* in scope, and why

- **Any document-derived string.** No document name, no page text, no entity
  name, no extracted metadata, no title, no `documentId`. §2 goes through both
  tables field by field and names the four that are unsafe and *why* — two of
  them are not obvious.
- **User emails, names, or any component-table read.** The dashboard identifies
  accounts by an opaque label and never joins to the Better Auth `user` table.
  §3.4 explains what that costs and why it is still the right call.
- **A registered-user count.** Reachable only through
  `components.betterAuth.adapter.findMany`, which returns whole user rows
  including emails. Deliberately not used. The dashboard reports *active
  accounts in the window* (distinct owners in `apiLogs`) instead, which is the
  number that actually drives a spend decision.
- **Admin write powers.** No ban, no impersonate, no delete-another-user's
  project, no reset-someone's-quota. Read-only means the endpoint set is queries
  only, which is a property `grep` can check (§5.3).
- **Per-user lifetime spend.** Requires an owner dimension on `apiUsageTotals`,
  which trips a live bug in the existing `totals` query (§4.5). Rejected on YAGNI
  grounds with the trigger for revisiting written down.
- **A separate admin app, deployment, or service account.** One deployment, one
  auth system, one extra route.

---

## 1. What exists today

| Fact | Evidence |
| --- | --- |
| `apiLogs` has no user dimension | `convex/schema.ts` — none of its fields identify a caller |
| `apiUsageTotals` has no user dimension | `convex/schema.ts` |
| `apiLogs` is written from exactly one mutation | `internal.apiLogs.record`, reached only via `usageLogger()` |
| 12 `usageLogger` call sites, in 6 files | `embeddings`, `processingNode` ×3, `relationshipsNode`, `renameNode`, `searchNode` ×3, `translationNode` ×2 |
| 9 of 12 already pass `documentId`; the 3 in `searchNode` pass nothing | all three sit inside `execute`, which has a **required** `args.projectId` |
| `SettingsPage` is the only consumer of `apiLogs.list`/`totals` | `src/pages/SettingsPage.tsx` |
| `documents.projectId` is **optional** | `convex/schema.ts` |
| `projects` has no `ownerId` | `convex/schema.ts` |
| No `table` primitive in `src/components/ui/` | `SettingsPage` uses a plain `<table>`; the eslint fence does not restrict it |

### 1.1 The uncomfortable precondition

Until auth-plan **phase 2** lands, `documents.list`, `pages.*`, `entities.*` and
the rest are scoped by nothing but `projectId` — which the caller supplies. In
that world "the admin cannot read other users' documents" is not a true statement
about this app for *any* signed-in user, admin or not. This dashboard neither
creates that exposure nor fixes it.

What this plan can honestly promise is narrower: **the admin capability adds no
new read path into content.** If phase 2 does its job, the boundary holds; if
phase 2 is skipped, the boundary was never there and no amount of care in
`convex/admin.ts` substitutes.

Consequence: **Stage A (§7) is safe to ship at any time. Stage B is blocked on
phase 2**, and not only for schema reasons.

---

## 2. What the admin can see, field by field

### 2.1 `apiLogs`

| Field | Verdict | Reasoning |
| --- | --- | --- |
| `_id` | safe | Opaque, and no endpoint accepts one. React key only. |
| `_creationTime` | aggregate | Per-call timestamps are a work-hours trace of another person. Bucket to the day. |
| `provider` | safe | `"interfaze"` \| `"openai"`. |
| `operation` | aggregate | The *value* is safe — a closed vocabulary from our own code. The *sequence* is not: `transcribe` says the user uploaded audio, `translate` says their document was not in the default language. Counts per operation are fine; a per-row feed is a behavioural trace. |
| `model` | safe | Deployment-wide constant. |
| `status` | safe | `"ok"` \| `"error"`. |
| `promptTokens` / `completionTokens` / `totalTokens` | aggregate | Per-row prompt tokens is a sharp, distinctive proxy for document length. Sums and percentiles only. |
| `costUsd` | aggregate | Derived from tokens; same reasoning. |
| `durationMs` | aggregate | Weaker length proxy. p50/p95 only. |
| `cacheHit` | safe | Boolean about our infrastructure. |
| **`error`** | **unsafe** | §2.2 |
| **`documentId`** | **unsafe** | §2.3 |
| `finishReason` | safe | Provider enum. |
| `promptHash` | safe | Hashes `operation + task + systemPrompt + responseSchema` and **nothing else** — document text is deliberately excluded, and the comment says so. |
| **`outputHash`** | **unsafe as a value** | §2.4 |
| `errorCode` | safe | Five-value closed union in `convex/interfazeErrors.ts`. This is what replaces `error`. |
| `buildSha` | safe | Deployment fact. |
| `ownerId` *(new, §4)* | pseudonymise | §3.4 |

### 2.2 `error` is a path to the document bytes

`classifyError` has five classified branches with our own messages, then a
fallback — `convex/interfaze.ts:160`:

```ts
const detail = (e.message ?? "").slice(0, 300);
return new InterfazeFailure(`Interfaze API error (${status})${detail ? `: ${detail}` : ""}`, { status });
```

`detail` is the provider's raw message about *our request*. That request, for
every parse/OCR/visual call, carries a `file` part built from
`await ctx.storage.getUrl(document.storageId)`. A provider error that echoes the
offending request — a fetch failure, a size rejection, a malformed-part
complaint — plausibly echoes that URL, and a Convex storage URL serves the bytes
to anyone holding it.

This is not a general worry that "errors sometimes contain PII". It is a
specific, traceable path from a log field to another user's PDF. **`error` is
never returned by an admin endpoint, raw or truncated.** `errorCode` answers
every question the dashboard actually has.

### 2.3 `documentId` is a handle, not a datum

The id is opaque. The problem is what it enables: `apiLogs.list` **already**
joins it to `documents.name` and `SettingsPage` renders that as a link. And
`documents.name` is largely written by Analyze from the document's contents.

So the unsafe thing is the *join*, and the join is one line away at all times.
Admin queries never return `documentId` and never `ctx.db.get` one. Its only
admin-safe use is `new Set(ids).size` computed server-side — "documents
touched", a number.

### 2.4 `outputHash` is a confirmation oracle

`outputHash: fnv1a(content.trim())`, where `fnv1a` is a **32-bit**
non-cryptographic hash and `content` is the model's raw output.

For a long structured Analyze response that is a fine fingerprint and
effectively unrecoverable. For the `rename` operation the output is essentially
a document title, and against a 32-bit hash an admin holding it can test
candidate titles offline until one matches. That is a content confirmation
oracle over someone else's document — exactly the failure mode this feature is
supposed to make impossible.

The legitimate measurement use — "did two uncached runs of the same `promptHash`
produce different output?" — is fully answered by **the count of distinct
`outputHash` values per `promptHash`**, which leaks nothing. Return the count,
never the hash.

### 2.5 `apiUsageTotals`

Every field is safe: `calls`, `promptTokens`, `completionTokens`, `costUsd`,
`cacheMeasuredCalls`, `cacheHits`. `shard` is an implementation detail of write
contention and is never returned. The table is nothing but aggregates, which is
the point of it existing. §4.5 is why it nonetheless does not change.

### 2.6 The dashboard, stated as its output

- **Deployment lifetime** — calls, input tokens, output tokens, estimated cost,
  vcache hit rate. Already computed by `api.apiLogs.totals`.
- **Window totals** (7 / 30 days) — the same five, plus error rate.
- **By operation** — calls, cost, error rate, p95 duration, truncation rate
  (`finishReason === "length"`).
- **By account** *(Stage B)* — opaque label, calls, tokens in/out, cost,
  documents touched, error rate, last-active day.
- **Activity by day** — calls and cost per day, all accounts summed.

No string sourced from a document appears anywhere in that list.

---

## 3. Deciding who the admin is

| Option | Verdict |
| --- | --- |
| **Hardcoded email constant** in `convex/authz.ts` | **Chosen** |
| Convex env var `ADMIN_EMAIL` | Rejected — §3.3 |
| Role field / `userRoles` table | Rejected — §3.3 |
| Better Auth `admin` plugin | **Rejected on facts, not taste** — §3.2 |

### 3.2 The Better Auth admin plugin does not fit

The plugin ships in `better-auth@1.6.28`. Two independent blockers:

**It needs schema the component does not have.** The plugin requires
`user.role`, `user.banned`, `user.banReason`, `user.banExpires` and
`session.impersonatedBy`. The component's shipped schema has none of them, and
its header says it is generated and not to be edited. Adopting the plugin means
vendoring the component's schema ("local install") before the login gate has even
been committed.

**Its headline capability is the thing we are forbidding.** The plugin exists for
ban, list-users, set-role and **impersonate**. Installing a plugin whose main
verb is "read another user's app as them", to build a feature defined by "must
not read another user's documents", is the wrong tool by more than a margin.

### 3.3 Why not an env var or a role table

**Env var.** `auth-plan.md` §4 already documents one deploy-skew footgun of
exactly this shape. `ADMIN_EMAIL` would be a second: a value that must agree
across deployments, is set outside git, changes without review, and whose absence
silently produces a deployment with no admin. It fails closed (a `string` never
equals `undefined`), but buys nothing over a constant except keeping one email
out of a private repo.

**Role table.** A schema addition, a bootstrap problem (who grants the first
role?), a seed step, and a grant/revoke surface — for one admin, with no second
one in sight. CLAUDE.md is explicit that a table nothing writes is speculative
generality. Note also that `convex/roles.ts` already exists and is about *entity*
roles inside documents; a `userRoles` table beside it would read as a matched
pair it is not.

**The constant wins where it matters:** one line, in git so a change to it is a
reviewable diff, cannot skew between deployments, and
`grep -rn ADMIN_EMAIL convex/` is the complete audit. A second admin turns it
into an array — a one-line change, so nothing is painted into a corner.

### 3.4 Two caveats that must not be skipped

**The admin email is a claim, not a proof.** `convex/auth.ts` sets
`requireEmailVerification: false`. Better Auth rejects a second signup for an
existing address, so once the account exists it cannot be taken — but until it
exists, whoever signs up first with `eliunited@gmail.com` *is* the admin. Hence:

1. **Claim the account before the app is reachable by anyone else.** This is a
   step in §8, not an aside.
2. Once it exists, pin the constant to the Better Auth **user id** instead of the
   email. An id cannot be claimed by signing up. It cannot be written before the
   account exists, so it is a follow-up commit.

Compare case-insensitively — Better Auth is believed to normalise stored emails
to lowercase, but the comparison costs nothing and removes the question.

**Accounts are pseudonymous in the UI.** The per-account table shows
`ownerId.slice(0, 8)`, not an email. Anonymised, not secret: a prefix of an
opaque id, consistent per row, not reversible to a person. The cost is real — the
owner cannot email a runaway account without a second, deliberate step. That is
the trade the requirement asks for, and the alternative is a `getAnyUserById`
call in `convex/admin.ts` returning the full user document. Once one such join
exists, "this file does not join to identity" stops being checkable.

---

## 4. Per-user attribution: the schema work

### 4.1 It does not exist today

Nothing on an `apiLogs` row says who caused it. Stage A therefore has no
per-account breakdown — and with one account, deployment totals *are* the
per-account totals.

### 4.2 One field on `apiLogs`, resolved at the chokepoint

```ts
// The Better Auth id of the account that caused this call, resolved at write
// time from the document's project. v.string(), never v.id("users"): the user
// record lives in the component's tables (docs/auth-plan.md §7.1).
ownerId: v.optional(v.string()),
```

plus `.index("by_owner", ["ownerId"])`.

**No `ctx.auth` is available at the write site.** `record` runs inside the
workpool → scheduler → internal action chain, where Convex does not propagate
identity. Ownership must arrive as data — and it already does, because the caller
knows a document or a project.

So `usageLogger`'s meta widens by one optional field, and `record` does the walk
once, in one place:

```ts
const projectId =
  args.projectId ??
  (args.documentId ? (await ctx.db.get(args.documentId))?.projectId : undefined);
const ownerId = projectId ? (await ctx.db.get(projectId))?.ownerId : undefined;
```

Two extra `ctx.db.get`s on a mutation that already does an insert, an index read
and a patch. Resolving here rather than at 12 call sites is the DRY choice, and
means a new logging call site cannot forget.

The three `searchNode` sites gain `{ projectId: args.projectId }` — required and
in scope at all three. The other nine already pass `documentId`.

**Attribution is a snapshot.** `convex/documentMove.ts` can move a document to
another project afterwards; historic rows keep the owner who paid. That is
correct for spend attribution and should be a comment, not a bug report later.

### 4.3 There is no widen → migrate → narrow here

CLAUDE.md's dance exists for *narrowing*. `apiLogs.ownerId` is never narrowed to
required, because three classes of row legitimately have none: rows written
before accounts existed, orphans whose document or project was deleted, and any
future call site with neither id in hand. So it is `v.optional(v.string())` on
the first deploy and forever — one deploy, not three. Unattributed rows
aggregate into an `Unattributed` line, which is honest and is also the only way
to notice if resolution silently stops working.

**Where the dance genuinely bites is upstream, and it is a blocker.**
`documents.projectId` is optional. A walk that hits `undefined` has no defined
answer, so `documentId → projectId → ownerId` is only trustworthy after
auth-plan §7.3 backfills and narrows it — and `projects.ownerId` (§7.2) has to
exist first. **Stage B is blocked on auth phase 2, both parts.**

### 4.4 The backfill

Once `projects.ownerId` exists, backfill the ≤30 days of live rows so the
dashboard is not mostly `Unattributed` on day one. House pattern — a
self-rescheduling paginated `internalMutation` in `convex/migrations.ts`,
modelled on `backfillPageProjectIds` (which already memoises `projectId` per
document across a batch, exactly the join needed here). Not a new dependency.

Safe to re-run and safe to run while the pipeline is logging. Rows whose document
or project is gone stay unattributed, which is the correct answer for an orphan.

### 4.5 `apiUsageTotals` is deliberately left alone

The obvious move is `ownerId` on the shard rows plus a `by_owner_and_shard`
index. **Do not.** `convex/apiLogs.ts:160`:

```ts
.take(TOTALS_SHARDS + 1);
```

That `.take(9)` is correct **only** while the table holds at most 8 shards plus
one legacy row. Add an owner dimension and the table grows to accounts × 8;
`totals` then silently sums the first 9 rows and under-reports lifetime spend,
with no error anywhere. The number every cost decision in this repo is read off
would quietly become wrong.

The question it would answer is per-account *lifetime* spend. The dashboard's
actual question — who is spending, now — is answered from `apiLogs` over the
retention window, which is the actionable window anyway.

> If per-account lifetime spend is ever needed, `apiUsageTotals` gains `ownerId`
> **and** `totals` must switch from `.take(9)` to an owner-scoped index read in
> the same commit. Splitting those across commits ships a silently wrong number.

---

## 5. Enforcing the boundary in code

Three layers. Each catches something the others do not, and none is a comment.

### 5.1 `adminQuery`, composed with the auth gate

**Correction, verified when this was built:** an earlier draft of this section
claimed `customQuery(authedQuery, adminMod)` does not typecheck. It does —
`tsc -b --force` accepts it. The real reason to avoid it is cheaper to state:
chaining the builders runs `getAuthUser` twice per request to answer one
question.

So composition happens at the **customization** level — admin as a strict
extension of authed, sharing a single `getAuthUser` call:

```ts
// convex/authz.ts — extends what is already there
/** The owner. In git on purpose: a change to this line is a reviewable diff. */
const ADMIN_EMAIL = "eliunited@gmail.com";

const adminOnly = customCtx(async (ctx: QueryCtx) => {
  const user = await authComponent.getAuthUser(ctx);
  if (user.email.toLowerCase() !== ADMIN_EMAIL) {
    throw new ConvexError("Not authorized");
  }
  return { user };
});

/** Queries only. There is no adminMutation, and adding one is a design change. */
export const adminQuery = customQuery(query, adminOnly);

/** Any signed-in user may ask; the answer is a boolean, never the email. */
export const isAdmin = authedQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => ctx.user.email.toLowerCase() === ADMIN_EMAIL,
});
```

Two deliberate omissions: there is no `adminMutation` (read-only enforced by the
wrapper set, not by discipline), and `ADMIN_EMAIL` never reaches the client —
`isAdmin` returns a boolean so the admin address is not a target published in the
bundle.

### 5.2 `returns:` validators — the platform's own allowlist

Every admin query declares an explicit `returns` object validator, so a future
`...row` spread fails loudly instead of leaking:

```ts
export const usageByAccount = adminQuery({
  args: { days: v.number() },
  returns: v.object({
    truncated: v.boolean(),
    rows: v.array(v.object({
      label: v.string(),            // ownerId.slice(0, 8) — never the raw id
      calls: v.number(),
      promptTokens: v.number(),
      completionTokens: v.number(),
      costUsd: v.number(),
      documentsTouched: v.number(), // a Set size; the ids never leave the handler
      errors: v.number(),
      lastActiveDay: v.string(),    // "2026-08-14" — day, not timestamp
    })),
  }),
  handler: async (ctx, args) => { /* ... */ },
});
```

`documentId`, `error` and `outputHash` are simply not in the shape. Preferring
the platform's own mechanism over a hand-rolled sanitiser, per CLAUDE.md.

*Verify rather than assume:* confirm on the first commit that Convex rejects an
unlisted extra field at runtime, by adding one deliberately and watching it fail.
If it does not, this layer is documentation and §5.3 has to carry more weight.

### 5.3 An eslint fence on `convex/admin.ts`

The design-system fence exists because the layer decays by *addition*. The same
decay applies here in a sharper form: nobody edits `usageByAccount` to leak a
filename — someone adds `documentBreakdown` six months from now and joins
`documents` because it was one line and obviously useful.

A new override block in `eslint.config.js` banning, inside `convex/admin.ts`:
`ctx.db.get` (every id it holds points at user content), any table other than
`apiLogs` and `apiUsageTotals`, and `getAnyUserById` (returns the full user
document including email).

**Check each selector against the actual AST before committing** — a
`no-restricted-syntax` selector that matches nothing passes silently, which is
the worst outcome for a rule whose whole job is to fail. The pre-existing lint
baseline is exactly 2 errors in `src/components/viewer/`; the gate stays "still
exactly 2".

### 5.4 The grep audits

All three must be empty, and belong in the final commit message:

```bash
grep -rn "adminQuery" convex/ | grep -v "convex/\(authz\|admin\)\.ts"
grep -rn "adminMutation\|adminAction" convex/
grep -n "documents\|pages\|entities\|blocks\|annotations\|metadata" convex/admin.ts
```

### 5.5 The aggregation cost, and the tripwire

`usageByAccount` scans `apiLogs` over a window. Two ceilings: Convex's 16,384
document read limit per query, and the fact that this is a **reactive
subscription** — every new log row re-runs the scan, and a bulk ingest writes ~28
rows per document.

At current volume this is comfortable. So: bounded scan over `by_creation_time`,
`.take(5000)`, and **return `truncated: rows.length === LIMIT`** so the UI can
say "showing the most recent 5,000 calls" rather than quietly presenting a floor
as a total. A silently-capped number is precisely the §4.5 failure.

> When `truncated` starts coming back `true`, add an `apiUsageDaily` table keyed
> `[ownerId, day]`, patched from `record` — the same denormalisation
> `apiUsageTotals` already establishes, so house pattern rather than a new
> dependency. `@convex-dev/aggregate` would also solve it and is heavier
> machinery than this table's size justifies.

---

## 6. The UI

**A new route, `/admin`.** Not a section of `SettingsPage`, and the reason is
enforcement rather than layout: a section on a shared page means the admin query
must return `null` for non-admins rather than throwing, because a thrown
`useQuery` breaks the whole page for everyone. Softening a refusal to keep a page
from breaking is how a boundary rots. A separate route lets `adminQuery` throw.

- **`src/pages/AdminPage.tsx`** on `PageShell` with
  `back={{ to: "/settings", label: "Back to settings" }}`.
- Stat cards reuse `SettingsPage`'s `StatCard` — hoist it into a shared module in
  the same commit rather than making a second copy.
- Tables are plain `<table>`, as `SettingsPage` already does. **No new UI
  primitive is needed** — no dialog, menu, tabs, or hand-rolled `role=`.
- Route registered inside the existing `<Authenticated>` block in `src/App.tsx`,
  alongside `/settings`.
- **Entry point:** a link in `SettingsPage` rendered only when
  `useQuery(api.authz.isAdmin)` is true. A non-admin who types `/admin` gets the
  thrown error, which is correct — the server is the gate, the hidden link is
  tidiness.

Keyboard verification per CLAUDE.md: two interactive elements (back link, window
selector), so the whole protocol is short. Short is not a reason to skip it.

---

## 7. Two stages

### Stage A — deployment-wide

No schema change, no backfill, no user dimension. Delivers `adminQuery`, the
eslint fence, `convex/admin.ts` with deployment / window / by-operation / by-day
aggregates, and `/admin`.

With one account this is complete, not a placeholder. More importantly it lands
the entire enforcement skeleton while there is nobody to leak to, so every
control is exercised before it matters. Depends only on `convex/authz.ts`.

### Stage B — per-account breakdown

Needs, in order: `projects.ownerId`, `documents.projectId` backfilled and
narrowed (shared with `project-profiles-plan.md`), then `apiLogs.ownerId` +
resolution in `record` + the 12 call sites + the backfill + the per-account
table.

Do not attempt Stage B before phase 2 — §1.1 applies, and building the dashboard
that respects a boundary which is not yet enforced creates a false impression
that it is.

---

## 8. Sequencing

| # | Commit | Depends on | Notes |
| --- | --- | --- | --- |
| **0** | **Claim the `eliunited@gmail.com` account** | auth commit 2 | Not a code change. `requireEmailVerification: false` makes the address first-come — §3.4. |
| 1 | `ADMIN_EMAIL`, `adminOnly`, `adminQuery`, `isAdmin` in `convex/authz.ts` | authz.ts | No endpoint uses it yet. Verify `customQuery(authedQuery, …)` really is rejected, so the §5.1 comment is true. |
| 2 | eslint override for `convex/admin.ts` | 1 | Lands **before** the file it fences. Check each selector actually matches. |
| 3 | `convex/admin.ts` — aggregates, full `returns` validators | 1, 2 | Confirm an unlisted extra field is rejected at runtime (§5.2). |
| 4 | `/admin` route, `AdminPage`, conditional link, `StatCard` hoisted | 3 | Keyboard pass. `curl` the endpoint with a non-admin session — testing through the UI proves nothing. |
| 5 | *(hardening)* pin `ADMIN_EMAIL` to the Better Auth user id | 0, 1 | One line. Removes the claim-the-address footgun. |
| — | **Stage A complete** | | |
| — | *(auth phase 2)* | | Hard blocker for everything below. |
| 6 | `apiLogs.ownerId` + index; `record` resolves it; `usageLogger` widens; 3 `searchNode` sites | phase 2 | Optional forever — one deploy (§4.3). |
| 7 | `migrations.backfillApiLogOwners` | 6 | Re-runnable. |
| 8 | `usageByAccount` + per-account table | 6, 7 | Opaque labels. Surface `truncated` in the UI. |

Commits 1–4 are the whole boundary. If Stage B never happens, Stage A is still a
coherent, shippable feature that leaks nothing.

---

## 9. Open questions

- ~~**Does Convex enforce a `returns` validator at runtime?**~~ **Answered: yes.**
  A handler returning a field the validator does not list fails with
  `ReturnsValidationError: Object contains extra field 'leaked' that is not in
  the validator`. §5.2 is real enforcement, not documentation.
- ~~**The eslint selectors in §5.3 are unverified against the AST.**~~
  **Answered: all three fire.** Verified against a file containing one
  deliberate violation of each, with an allowed `apiLogs` read in the same file
  staying clean.
- ~~`customQuery(authedQuery, …)` does not typecheck.~~ **Wrong — it does.**
  See the correction in §5.1; the real reason to compose at the customization
  level is that chaining builders calls `getAuthUser` twice.
- **Whether `promptHash` stays content-free.** It is today, deliberately. If
  anyone adds document text to that hash input, `promptHash` moves from safe to
  unsafe with no signal. Worth a line in the `chatCompletion` comment saying the
  admin dashboard depends on it.
- **Whether pseudonymous accounts are acceptable in use.** §3.4 makes the call,
  but it is the one decision driven by the requirement's wording rather than a
  technical constraint, and the most likely to be revisited.

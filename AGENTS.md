<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

## First principles

**YAGNI.** Build for what is needed now. Speculative generality — an operator
nobody constructs, a vocabulary nothing renders, a table nothing writes — costs
maintenance forever and buys nothing. Delete on sight.

**DRY.** One source of truth per fact. Duplicated schemas, vocabularies and
helpers drift silently: a second copy of the Analyze schema quietly stopped web
clips from ever extracting, because only one copy gained a field.

Both cut both ways. Before deleting something as unused, check that it really is
unused — grep the call sites, read the live data. Several confident "nothing uses
this" claims in this repo's history turned out to be wrong.

## Interfaze

**An extra API call is the last resort.** Every call re-sends the document and
bills for it. In order of preference:

1. **Add a field to an existing structured call.** The Analyze response already
   carries the document text and the model's reasoning about it, so a new field
   there is nearly free. The library title moved this way and got *better*: it
   could then name the document by the kind that same response had just derived.
2. **Compute it deterministically.** No call at all.
3. **A new call**, only when the work genuinely cannot ride along. Cheaper is not
   automatically better — merging Analyze and Extract was measured at −2% cost
   and −57% extracted values.

**Design for the cache.** Interfaze serves a repeated call from `vcache` for
free, but only if the request is byte-identical — so anything feeding a prompt
must be deterministically ordered (see the kind-list sort in `analyzePrompt.ts`).
Streaming hardcodes `vcache: false`, which is why this codebase never streams.
Cache-key composition is undocumented, so log the hit rate rather than assume it.

**Size ceilings are per transport, and this is the recurring trap.** URL in
prompt *text* is 80MB; base64 and binary file objects are 20MB. This app sends a
URL wrapped in a `file` part — the *file-object* transport — so 20MB applies even
though no bytes are inlined here. The preflight gate is sized to that.
URL-in-text would lift it but measured 11× the cost for identical results.

**Other constraints:** one task per call; precontext entries are per
task-invocation, not per page; `total_pages` is undocumented, so assert rather
than infer; output is billed per token *emitted*, so a defensive `maxTokens` cap
can only lose a completed response, never save money.

## Recurring gotchas

- **Schema property order is behavior.** Structured-output generation follows
  declaration order, so the order in `buildDocumentUnderstandingSchema` encodes a
  reasoning chain: evidence → kind → category → title → dates. The title is
  written before any date field, so no date is in context when it is written.
  Treat a field move here as a behavior change worth a before/after run.
- **LSP `findReferences` is blind to Convex.** Functions are called through the
  `api.*`/`internal.*` codegen proxy, which tsserver does not trace — it reports
  live functions as unreferenced. Use it freely on `src/`; use
  `grep -rn 'internal\.mod\.fn\|api\.mod\.fn'` on `convex/`. Neither sees index
  names, which are string literals and recur across tables (`by_page` exists on
  two).
- **Narrowing a schema field needs widen → migrate → narrow.** Convex rejects
  rows carrying fields the schema no longer declares, so strip the data first.
  A deploy will refuse you if you forget, which is the good outcome.
- **Every Convex export is a public endpoint**, not just code: an uncalled
  `query`/`mutation`/`action` is reachable and unauthenticated. Likewise an
  unused index is a write cost on every insert.
- **Verify a claim about a specific line before acting on it.** Comments and
  docs — including this file's own history — have described bugs that were
  already fixed.

## Reliability and measurement

Terminal state for queued work comes from the pool's `onComplete`
(`processing.jobComplete`, `pageImages.renderJobComplete`), which fires on
success, failure and cancellation — including the Convex 10-minute action kill,
which a `catch` block cannot observe. New stages pass `{ documentId, stage }` to
`processingEnqueueOptions` rather than arming their own timer.

`chatCompletion` is the single Interfaze chokepoint and stamps `finishReason`,
`promptHash`, `outputHash`, `errorCode` and `buildSha` onto the `apiLogs` row it
was already writing, so production traffic doubles as the benchmark corpus.
Prefer adding a metric there over building an offline harness; what cannot move
is anything needing a known-correct answer. `documents.displayNameSource ===
"human"` is a free human-rejection label already in the database.

`apiLogs` detail expires after 30 days (`convex/crons.ts`); lifetime spend lives
in `apiUsageTotals`, which is never pruned.

## Workflow

- **Commit atomically, straight to `main`.** No feature branches, no PRs.
- **Deploying is not git.** `npm run deploy` publishes the frontend to Convex
  static hosting; `npx convex dev` pushes backend functions and schema. Pushing
  a commit deploys nothing.

## Cost shape (measured, 12-page born-digital English PDF)

Scan $0.0021 → Analyze $0.0308 → Rename $0.0062 → Extract $0.0271 = **$0.066/doc**.
Analyze and Extract are ~88% of it. Each *additional* extraction template
re-sends the whole document at +$0.027.

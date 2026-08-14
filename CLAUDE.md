<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

## First principles — these outrank everything below

**The least code that satisfies the request. When in doubt, don't write it.**
Doubt is a signal to stop and ask, not to write something plausible and annotate
the risk afterwards. Uncertain whether a case can happen, whether a field is
read, whether the platform already does this — say so and wait. An unwritten
line is free to write later; a written one is maintained forever.

**Take the request, not the wording.** A literal reading that leads away from
what the platform does natively is the single most common way this rule gets
broken, because the literal version looks like progress. "Plaintext title
search" describes a symptom: the literal answer was a substring scan over every
document in the project, the right one was a second `searchIndex` on the field —
twenty lines against three, and a per-keystroke table read against none. Propose
the idiomatic version *before* building, ship it, and name the trade-off it
makes. Don't hand over the literal version and list its costs at the end.

This is not only about search. Anything the platform already solves — indexes,
components, `onComplete`, scheduled functions — makes a hand-rolled equivalent a
finding to report, not a deliverable to write.

**YAGNI.** Build for what is needed now. Speculative generality — an operator
nobody constructs, a vocabulary nothing renders, a table nothing writes — costs
maintenance forever and buys nothing. Delete on sight.

**DRY.** One source of truth per fact. Duplicated schemas, vocabularies and
helpers drift silently: a second copy of the Analyze schema quietly stopped web
clips from ever extracting, because only one copy gained a field.

All of these cut both ways. Before deleting something as unused, check that it
really is unused — grep the call sites, read the live data. Several confident
"nothing uses this" claims in this repo's history turned out to be wrong. The
rule is *less code*, not *fewer lines in this file*.

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
though no bytes are inlined here. URL-in-text lifts it but measured 11× the cost
for identical results, so `fileUrlContent` sends a file part by default and falls
back to text only above 19MB; both numbers live in `convex/interfazeLimits.ts`
and the browser preflights import them, so the gate a user sees and the gate the
pipeline enforces cannot drift. Nobody has ever measured what actually happens
past 20MB — the old 18MB gate blocked those files before they were sent.

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
- **`AGENTS.md` is a symlink to this file.** One source of truth, two names, so
  a non-Claude agent reads the same principles. Edit `CLAUDE.md`; never replace
  the symlink with a copy.
- **A hook lints each file as it is edited.** `.claude/hooks/lint-edited-file.sh`
  runs eslint on the single `.ts`/`.tsx` file a tool just wrote and hands any
  error back. Scoped to one file deliberately: this repo is often edited by more
  than one process at once, so a whole-repo error count is not a stable
  baseline — measured drifting 2 → 4 → 3 within minutes. It makes the fence
  below fire at edit time; it does not replace `npm run lint`.

## Cost shape (measured, 12-page born-digital English PDF)

Scan $0.0021 → Analyze $0.0308 → Rename $0.0062 → Extract $0.0271 = **$0.066/doc**.
Analyze and Extract are ~88% of it. Each *additional* extraction template
re-sends the whole document at +$0.027.

## UI

**Base UI is the only source of interactive behavior.** `src/components/ui/`
wraps it; screens import from there, and eslint fails the build if they reach
past it. This decays by *addition*, not by edit — nobody rewrites the shared
dialog, they write a new inline one — which is why the fence is a lint rule and
not a paragraph. The proof it was needed: `ui/dialog.tsx` had exactly one
consumer while `StageRetryDialog`, `SelectionPopover` and `AnnotationLayer` each
hand-rolled `createPortal` + `role="dialog"` + a `window` keydown listener. None
trapped focus, none restored it, and because the listener was on `window` a
single Escape over the viewer closed the retry dialog too.

Writing `role=`, `aria-modal`, or a focus/Escape `useEffect` by hand is the
signal that you reached past a primitive. Hand-rolled ARIA is only correct where
Base UI has no equivalent — `SplitPane` and the PDF overlays qualify; say so in
an `eslint-disable` with a reason, which leaves a grep-able mark.

**The type scale is closed; nothing enforces it but lint.** `--text-*: initial`
in `@theme` deletes the *named* steps Tailwind ships, but `text-[11px]` is a
parser feature and compiles regardless — measured, not assumed. Same for the
`text-sm/6` slash form, which silently drops the step's tracking and weight
rather than overriding them. A value that isn't on the scale is a token that was
never named: add it to `@theme` in `src/index.css`.

**`@theme` vs `@theme inline` is load-bearing.** The colour block is `inline` so
alpha modifiers read the raw runtime var. The type block must *not* be: its
paired modifiers (`--text-sm--line-height` and friends) are emitted as real
custom properties and read at use site, so marking it `inline` erases every
line-height, tracking and weight in the scale with no error.

**Verification is keyboard-first.** A change to anything interactive is
unverified until it has been driven Tab / Shift-Tab / Enter / Escape, with the
focus ring visible at every stop and focus back on the trigger after close.
`npx tsc -b` and `npm run lint` catch the import rules; nothing but doing it
catches a broken focus trap. `src/` lints clean as of the viewer render-phase
fixes; keep it there. Still treat a repo-wide count as a smell rather than a
gate — it drifts while another session or your editor is writing, so "is it
still exactly N" answers the wrong question. The gate is that the file *you*
touched lints clean, which the edit-time hook already enforces.

**Reset state during render, not in an effect.** Both viewer errors were the
same shape: work that belongs in the render pass deferred into `useEffect`,
which buys a wasted render and, in `ImagePdfViewer`, one paint against the
previous document's geometry. Compare against the previous value and adjust
inline — `if (next !== seen) { setSeen(next); … }` — the way the pin-drop lines
in `ViewerLayout` already did. A ref written during render is the same mistake
wearing a disguise: `layoutRef` existed only to dodge an effect's dependency
array, so removing the effect deleted the ref too.

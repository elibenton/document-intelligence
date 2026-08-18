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
search indexes, components, scheduled functions, crons — makes a hand-rolled
equivalent a finding to report, not a deliverable to write.

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

### What a response actually looks like — start here

Every call goes through `chatCompletion` in `convex/interfaze.ts` and comes back
as an `InterfazeChatCompletion`: the OpenAI chat-completion shape plus `vcache`,
`precontext` and `reasoning`. Real capture, 3-page PDF, `task: "ocr"`:

```jsonc
{
  "id": "…",
  "object": "chat.completion",
  "model": "interfaze-beta",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",        // "length" = truncated; you paid, JSON won't parse
      "message": { "role": "assistant", "content": "…see below…" }
    }
  ],
  "usage": { "prompt_tokens": 1286, "completion_tokens": 47, "total_tokens": 1333 },
  "vcache": false,                    // true = served from the semantic cache, free
  "precontext": []                    // specialist output on *full-model* calls only
}
```

`message.content` is **always a string**, and which of three shapes it holds is
decided by how the call was made:

| Call | `content` | Where the payload is |
|---|---|---|
| `task: "ocr"` (and other tasks) | `{"result": {…}}` | on `content` — `precontext` is empty |
| `response_format` (Analyze, Extract, Transcribe) | your schema, JSON-stringified | on `content` |
| plain completion | prose | specialist output on `precontext` |

That first row is the one that keeps getting reinvented: a task's payload rides
on `content`, so `ocrDocument` parses it and re-wraps it as
`[{ name: "ocr", result }]` — the precontext shape everything downstream already
understands. Note the token counts: 47 completion tokens against 7.6k characters
of returned OCR — a task's payload is plainly not billed as emitted tokens,
which is where the ~100x saving over the full model shows up. The same document
through the full model measured 3,488 completion tokens and $0.20.

The OCR `result` — abridged, but every field and every number below is from a
real 3-page 1224×1584 capture:

```jsonc
{
  "extracted_text": "Synthetic Test Document - Page 1\n01 declaration record…",
  "width": 1224,
  "height": 4752,            // 3 × 1584 — the STACK, not a page. This is the trap.
  "total_pages": 3,          // undocumented; assert, never infer
  "sections": [              // one per page here — but that is not guaranteed
    {
      "text": "Synthetic Test Document - Page 1\n01 declaration record…",
      "lines": [
        {
          "text": "Synthetic Test Document - Page 1",
          "average_confidence": 0.99,          // lines: average_confidence
          "bounds": {                          // 4 corners + w/h, not x/y/w/h
            "top_left":     { "x": 138, "y": 123 },
            "top_right":    { "x": 481, "y": 123 },
            "bottom_right": { "x": 481, "y": 149 },
            "bottom_left":  { "x": 138, "y": 149 },
            "width": 343, "height": 26
          },
          "words": [
            {
              "text": "Synthetic",
              "confidence": 0.99,              // words: confidence
              "bounds": { "top_left": { "x": 144, "y": 124 }, "…": "…" }
            }
          ]
        }
      ]
    }
  ]
}
```

Whole-document OCR reports the *stacked* height and section bounds that may be
tiled down the stack or page-local depending on the document — `ocrPrecontextToPages` in
`convex/interfazeOcr.ts` owns that guessing, and `interfaze.test.ts` pins both
shapes. Don't re-derive pagination at a call site.

Two failure shapes worth recognizing on sight: `content: ""` with a non-zero
`completion_tokens` is the provider dropping output it generated and billed (not
an empty document — `ocrDocument` throws `empty_ocr_response` on it), and
`finish_reason: "length"` means a structured response was cut mid-JSON.

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
must be deterministically ordered (the kind-list sort in `analyzePrompt.ts`,
the planner-vocabulary sorts in `search.ts`). Streaming hardcodes `vcache:
false`, which is why this codebase never streams. Cache-key composition is
undocumented, so log the hit rate rather than assume it — and beware the
semantic side of it: probes (2026-08-18) caught the cache matching "similar
prompt, different URL-in-text" and serving *another document's* answer, one of
two reasons URL-in-prompt-text is banned here.

**One transport, one measured ceiling.** Every call sends the document as a
`file` content part carrying the storage URL. Never put a document URL in
prompt text for a full-model call: measured 2026-08-18, the model silently
analyzed the wrong document three times out of three that way (tasks tolerate
it — `transcribe` still uses it deliberately). The ceiling is
`PROVIDER_FILE_PART_SAFE_BYTES` = 34MB in `convex/interfazeLimits.ts` —
measured, not documented: the docs claim 20MB, a 34MB part worked, a 62MB part
died in an opaque 500. Browser preflights import the same constant, so the gate
a user sees and the gate the pipeline enforces cannot drift.

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

Terminal state for queued work does not come from a `catch`: the Convex action
kill at 10 minutes never runs one, so `sweepStuckJobs` (`convex/crons.ts`)
fails any job left `running` past a legal action lifetime, and a stage's own
`catch` — which has a real message and a `FailureCode` — wins when it does run.
New work goes through `processing.enqueueStage`; do not arm your own timer or
per-stage watchdog.

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

## Cost shape (measured 2026-08-18, 5-page PDF / 1-hour recording)

One `understand` call per document: ~$0.21 for the PDF; the recording adds the
diarization shim's `transcribe` task (~$0.11) for ~$0.34 total. That replaced
the old Scan+Analyze+Rename+Extract chain (~$0.07–0.37/doc) — the PDF got more
expensive and the recording broke even, bought deliberately for the one-call
architecture (see the reinstatement note on `understandDocument`). An exact
re-run is a free vcache hit. Re-measure from `apiLogs` (`operation:
"understand"`), not from this paragraph.

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

**Verification is keyboard-first — for overlays.** Adding or changing something
that *manages focus* — a dialog, popover, combobox, menu, tab set, or a new
primitive in `src/components/ui/` — is unverified until it has been driven
Tab / Shift-Tab / Enter / Escape, with the focus ring visible at every stop and
focus back on the trigger after close. `npx tsc -b` and `npm run lint` catch the
import rules; nothing but doing it catches a broken focus trap.

The scope is deliberate and was narrowed after it cost more than it found. This
does *not* apply to routing, layout or structural work that moves existing
controls around without changing their behaviour: the React Router framework-mode
migration triggered a full pass that confirmed a tab order nobody had touched.
If the diff contains no `role=`, no focus management and no new primitive, the
keyboard pass is not the gate — the browser check that the page still renders is. `src/` lints clean as of the viewer render-phase
fixes; keep it there. Still treat a repo-wide count as a smell rather than a
gate — it drifts while another session or your editor is writing, so "is it
still exactly N" answers the wrong question. The gate is that the file *you*
touched lints clean, which the edit-time hook already enforces.

**Reset state during render, not in an effect.** Both viewer errors were the
same shape: work that belongs in the render pass deferred into `useEffect`,
which buys a wasted render and, in `PdfViewer`, one paint against the
previous document's geometry. Compare against the previous value and adjust
inline — `if (next !== seen) { setSeen(next); … }` — the way the pin-drop lines
in `ViewerLayout` already did. A ref written during render is the same mistake
wearing a disguise: `layoutRef` existed only to dodge an effect's dependency
array, so removing the effect deleted the ref too.

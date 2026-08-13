<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

## Interfaze usage rules (re-verified against interfaze.ai/docs + the shipped SDK, 2026-08-13)

- **Precontext entries are per-task-invocation, not per-page.** Docs: repeated tasks yield multiple entries with the same `name`; nothing ties an entry to a page. Only map entry→page when entry count == page count, and assert it. (Historical note: `ocrToPages` moved to `convex/interfazeOcr.ts`, its `ocrs.length > 1` branch is guarded, and `ocrDocument` synthesizes exactly one entry at `interfaze.ts:456` — so that branch is unreachable from production. Nothing is corrupted today.)
- **One task per call.** `task: "ocr"` cannot also return `object_detection`. A full completion *can* return both (precontext may mix task types). Objects + OCR = either one full call or two task calls. Note the SDK guard at `dist/index.js:380` is about the explicit `task` **parameter** only — it says nothing about whether the MoA router runs an internal specialist, which it will on a normal completion.
- **`total_pages` is undocumented.** The sections-as-pages height division is inference; assert it, fail loudly, never emit empty pages.
- **Size ceilings by transport — this is the one people get wrong.** URL-in-prompt-*text* 80MB; base64 20MB; **binary file object 20MB**. We send documents as a **URL wrapped in a `file` content part** (`fileUrlContent` → `inputs.file`), which is the *file-object* transport and subject to the **20MB** ceiling even though no bytes are inlined by this app. That is why the PDF preflight gate is 18MB — **do not raise it to 80MB.** Switching OCR to URL-in-text would lift the ceiling but was measured at 11× the cost ($0.0238 vs $0.0021) for byte-identical results. Also: 5-min request timeout; 1M context; 32k output tokens; 50 rps.
- **Don't re-upload for text work.** Extract goes text-in, chunked. Import `LIMITS.maxInlineTextBytesPerFile` (250,000) from the SDK rather than hardcoding it.
- **Never cap `maxTokens` defensively.** Output is billed per token *emitted*, so a cap can never save money — it can only lose a completed response and make you pay twice. The API ceiling is 32,000. The only justified cap is where a short output is the actual spec (e.g. a title).
- **Schema property order is load-bearing.** Structured-output generation
  follows declaration order, so the order in `buildDocumentUnderstandingSchema`
  encodes a reasoning chain: `kind_evidence` → `primary_kind` →
  `primary_category` → `display_title` → dates. The title is written *after* the
  kind so it can name the document by a type the model just derived from a
  quote, and *before* any date field so no date exists in context — that is how
  "never put a date in a title" survives without the separate call that used to
  enforce it by withholding the date from its input. Reordering these fields
  changes behavior, not just style.
- **Keep extraction as ONE merged schema.** `extractionSchema.ts` compiles all suggested extractions into a single call. A "one call per field" refactor would multiply the per-document bill by the field count.
- **Non-streaming only.** Streaming hardcodes `vcache: false` (`dist/index.js:247`), so a stream can never report a cache hit. Usage is *preserved when present* but is absent in practice because the SDK never sets `stream_options.include_usage` — don't "fix" this by patching the accumulator.
- **`vcache` invalidation is undocumented.** Several comments bank on an unchanged text-in re-run hitting cache. The docs say only "the same file or a very similar prompt" — no key composition, no TTL. It is a reasonable bet, not a guarantee. Log the hit rate rather than assuming it.

## Repo conventions

- **Every Convex export is public API.** A `query`/`mutation`/`action` with no
  `api.*`/`internal.*` caller is not just dead code, it is a reachable
  unauthenticated endpoint. Prefer `internalQuery`/`internalMutation` unless the
  frontend actually calls it, and delete on sight when a caller goes away.
- **Indexes are a write cost, not a free read speedup.** Every index is written
  on every row insert. `blocks.by_blockId` had zero callers and cost an index
  write on every OCR line the system had ever produced. Before adding one, name
  the `withIndex` call site; when deleting a query, check whether its index is
  now orphaned.
- **LSP `findReferences` is authoritative for `src/`, and blind for `convex/`.**
  Convex functions are called through the `api.*`/`internal.*` codegen proxy,
  which tsserver does not trace: `findReferences` on `renameNode.runRenamePass`
  returns only its definition, though `metadata.ts:184` and
  `processingNode.ts:656` both schedule it. **Never conclude a Convex function is
  dead from LSP.** Use it freely on plain TS/TSX, where it beats grep (exact,
  no substring or comment hits); use `grep -rn 'internal\.mod\.fn\|api\.mod\.fn'`
  on the Convex layer. Neither tool can see index names, which are string
  literals inside `withIndex("...")` — read the enclosing `query("<table>")`.
- **Verify a claim about a specific line before acting on it.** Several
  confidently-worded findings in the simplification audit — including one that
  had been sitting in this file — were about already-fixed or unreachable code.
  Grep the call sites yourself; `internal.x.y` and a bare symbol name are
  different searches, and index names are shared across tables (`by_page` exists
  on both `blocks` and `pageTranslations`, and only one of them was live).
- **There is no `scripts/` directory, and adding one back needs a reason.** It
  held 4,122 lines of concluded PDF/OCR investigation — no CI, no committed
  baseline, real API spend per run, and typechecked by nothing (it was in no
  tsconfig `include`). The findings live in `docs/pdf-edge-cases.md`, the fix
  shipped in `src/lib/pdfPreflight.ts`, and git history holds the apparatus. A
  metric that can be computed at the Interfaze chokepoint belongs there instead;
  only a metric needing a known-correct answer justifies an offline harness.

## Taxonomy

Documents carry two type fields and they are **not** interchangeable:
`primaryKind` is an open free-text vocabulary the model proposes from quoted
evidence; `primaryCategory` is one of the broad buckets in the
`documentCategories` table. The table is deliberately user-editable — the keys
and labels in a live deployment are not the seeded defaults, and the Analyze
prompt's category enum and instruction are built from the live rows so they can
never drift from what the UI shows. Do not freeze it into a constant.

`documentTypes` (a hierarchical path) and `suggestedSplits` used to be a third
and fourth vocabulary. Both were write-only and are gone.

## The view engine is used — do not "simplify" it

`src/lib/views` + `src/components/views` (filters, multi-key sort, group-by,
group ordering, the Properties panel) is a configurable-view system that a
simplification audit proposed cutting by ~700 lines on the premise that its
capabilities were reachable but unused. **That premise is false.** Live
`projectViews` rows show customised `visibleProperties` differing per project,
`groupBy` in use on both lists, and a filter the user had begun building.
Decision 2026-08-13: the whole surface stays. Do not re-propose it.

## Reliability

Terminal state for a queued stage is written in exactly one place: the pool's
`onComplete` (`processing.jobComplete`, `pageImages.renderJobComplete`). It fires
on success, failure and cancellation — including the Convex 10-minute kill, which
an action's own `catch` cannot observe. Do not add a dead-man's-switch timer
alongside it; five of those existed and every one duplicated a verdict
`onComplete` already had. New stages just pass `{ documentId, stage }` to
`processingEnqueueOptions`.

## Measurement: production traffic is the benchmark

Every Interfaze call is a benchmark row. `chatCompletion` (`convex/interfaze.ts`)
is the single chokepoint, and it stamps five fields onto the `apiLogs` row it
already wrote — no extra API call, no extra database write, no call site
involved:

| Field | Answers |
|---|---|
| `finishReason` | Did the provider truncate? `"length"` means we paid in full for unparseable JSON. |
| `promptHash` | Cohort key over prompt/schema *shape* only, never document text. Attributes a regression to the change that caused it. |
| `outputHash` | Two uncached runs of one `promptHash` returning different bytes = non-determinism, measured on real traffic for free. |
| `errorCode` | Classified failure, so errors group without parsing free text. |
| `buildSha` | Which deploy produced the row. Without it a metric stream is unattributable. |

**Add measurement here, not in a bench script.** An offline benchmark derived 24
of its 31 columns from data already available at this call site and charged real
money per run to get them. Before writing a script that measures Interfaze
behavior, check whether the chokepoint can compute it. What genuinely cannot
move is anything needing an oracle — OCR fidelity against a native text layer,
TOC accuracy against labels — because production has no known-correct answer.

**Free quality labels already in the database:** `displayNameSource === "human"`
(`convex/documents.ts`) is a user rejecting a machine-generated title, joinable
to the Analyze call that produced it. An operator retry is a human paying twice
to say the first answer was wrong. Neither needs a labeling UI.

**Retention:** `apiLogs` is a measurement stream and expires after 30 days
(`convex/crons.ts` → `apiLogs.pruneOldLogs`). The lifetime ledger is elsewhere —
sharded `apiUsageTotals` rows, never pruned. Don't put anything in `apiLogs`
that must survive.

## Cost shape (measured, 12-page born-digital English PDF)

Scan $0.0021 → Analyze $0.0308 → Rename $0.0062 → Extract $0.0271 = **$0.066/doc**.
Analyze + Extract are **88% of the bill and send substantially the same 17–18k input tokens**. That is where cost work belongs; deleting lines of Interfaze glue saves $0.00. Each *additional* extraction template re-sends the full document at +$0.027.

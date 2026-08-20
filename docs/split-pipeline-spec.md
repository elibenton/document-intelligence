# Split-pipeline implementation spec

**Status:** implemented and deployed 2026-08-19 (Phases 1, 3–6; Phase 7
deliberately deferred). Phase 2's live audio-TOC validation is still owed:
Interfaze credits were exhausted at build time — once credits are added, run
two recordings through `processing.runAnalyze` with bypassCache and check
`time_seconds` monotonicity before trusting timestamp TOCs.
**Decision:** retire the merged file-in `understand` call in favor of task-first
extraction + text-in analysis, make translation prompt-only (never automatic),
and expose per-type re-run affordances. Direction agreed after measuring live `apiLogs`: median
$0.27/call merged vs ~$0.08 split for documents, with the merged call's
precontext ride-along currently broken by two reported provider bugs (empty
precontext on full-model calls; STT precontext missing speaker labels).

## Target architecture

| Type | First run | Analysis | Heavy re-run | Cheap re-runs |
|---|---|---|---|---|
| PDF (native text) | browser text layer, no API call | text-in analyze | — | re-analyze, add entity |
| PDF (scan) / image | `ocr` task, file sent once | text-in analyze | Re-OCR → re-analyze | re-analyze, add entity |
| CSV | local `csvSearchPages`, no extraction call | text-in analyze (csv prompt) | — | re-analyze, add entity |
| Audio / video | `transcribe` task, file sent once | text-in analyze (time-based TOC) | Re-transcribe → re-analyze | re-analyze, add entity |
| Web clip | clipper Readability, local | text-in analyze (no TOC) | — | re-clip (local), re-analyze, add entity |

Invariants:

- The original file is sent to Interfaze **at most once per (re-)extraction**,
  only by `ocrDocument` and `transcribe`. Nothing downstream ever sends it.
- All analysis, entity extraction, and translation read stored text
  (`pages` / `blocks` / `transcriptSegments`).
- Translation **never runs automatically**. When the detected language is
  known and differs from the user's default, the document surfaces a prompt;
  every translation run is user-initiated. Unknown language surfaces a
  "translate anyway" variant of the same prompt. Nothing in the pipeline
  schedules a translate call.
- Word-level citations are unaffected: geometry comes from the OCR task
  payload, timestamps from the transcribe task, offsets from clip blocks —
  none of it ever came from the analysis call.

## Phase 1 — Translation becomes prompt-only (independent; highest pain; do first)

**Semantics: no code path may start a translate call except a user-initiated
mutation.** Detection classifies; the UI prompts; the user spends.

### 1a. One classifier, one place

New pure leaf module `convex/translationGate.ts` (pure so Vitest can import it
— `_generated/server` imports kill the suite):

```ts
type Decision = "offer" | "not_needed" | "unknown";
translationDecision(args: {
  sourceLanguageCode: string | undefined;  // "und" or undefined ⇒ unknown
  sourceLanguageIsMixed: boolean | undefined;
  targetLanguageCode: string;
}): Decision
```

Rules: `unknown` when code is missing or `"und"`; `offer` when
`sourceLanguageIsMixed === true` or code ≠ target; `not_needed` when code
matches target. This replaces the skip condition in `translateDocument`
(`convex/translations.ts:630-642`), whose `sourceLanguageIsMixed === false`
exact-match requirement is one of the live bugs (a detection that skips
writing the field makes the gate permanently un-armable). The decision only
ever sets `translationStatus` — it never schedules work.

Consumers: the persist path (below), `translations.start`,
`settings.updateDefaultLanguage` re-evaluation. Unit-test the module directly.

### 1b. Remove every automatic scheduling path

- Delete `scheduleTranslation` from `runAnalyze`'s `finally`
  (`convex/processingStages.ts:440`) and `runPipeline`'s `finally` (`:740`) —
  and do not reschedule it anywhere. This is the fix for the screenshotted
  failure: Analyze died on credits, the `finally` fired a translate call
  anyway on an `en-US` document. (The comment at `:432-439` justifying the
  `finally` cites a `beginTranslation` early-return that does not exist — see
  1d.)
- The persist path (after `translations.setSourceLanguage`) now only stamps
  the decision: `not_needed`, `offer`, or `unknown_language`. When Analyze
  fails before detection, stamp `unknown_language`.
- `settings.backfillTranslations` (`convex/translations.ts:159-206`) stops
  queueing runs. On a default-language change it walks the user's documents
  re-evaluating decisions only: documents whose completed translation targets
  the old language flip back to `offer` (existing `pageTranslations` are kept
  — the `sourceFingerprint` cache makes a later re-run cheap where content
  overlaps). Zero API calls.
- `scheduleTranslation` (`processingStages.ts:104-129`) is deleted once no
  caller remains.

### 1c. Determinate detection state, clip seed trusted

`translations.setSourceLanguage` (`convex/translations.ts:148-170`): when the
incoming code fails the validation regex at `:160`, write
`sourceLanguageCode: "und"` explicitly instead of writing nothing. Detection
state must always be determinate: known code, or known-unknown.

Seed web clips at creation: `clips.createFromClip` already receives the page's
`lang` (stored unused in the metadata JSON, `convex/clips.ts:189`). Normalize
(`en-US` → `en`, validate ISO 639) and persist through the same
`setSourceLanguage` path; stamp the decision immediately so a French clip
shows its translate prompt the moment it lands, before Analyze finishes.
Analyze's detection later overwrites the seed and re-stamps. The seed is
trusted: a wrong `lang` can only mis-word a prompt, never spend money.

### 1d. Fix the lifecycle re-open

`beginTranslation` (`convex/translations.ts:192-234`) checks only
`isCurrent` (language + version); every re-analyze flips `translationStatus`
back to `"translating"` and re-walks the document. Add the early return:
lifecycle already `complete` / `not_needed` for the current language + version
⇒ return false, touch nothing. Re-analyze may re-stamp `offer`/`not_needed`
from fresh detection, but must never restart a run or downgrade `complete`.

### 1e. One user-initiated entry point + UI states

- One authed mutation `translations.start(documentId)` replaces
  `translations.retry` (`:532-547`): legal from `offer`, `unknown_language`,
  `failed`, or a stale-version `complete`; illegal from `not_needed` unless an
  explicit `force` arg is passed (the "translate anyway" case). It re-reads
  the current default language, then enters the existing
  `queueTranslation` → `translateDocument` lifecycle unchanged.
- Schema: widen `documents.translationStatus` union
  (`convex/schema.ts:355-363`) with `"offer"` and `"unknown_language"`.
  Additive widen — no migration. Existing `complete`/`not_needed` rows keep
  their meaning.
- `DocumentPage.tsx` (`:773-782` region) renders by status: `offer` →
  "In French — translate to English?" button (wording from
  `sourceLanguageCode` + default); `unknown_language` → "Language unknown —
  translate anyway?"; `failed` → existing retry treatment; `translating` /
  `queued` → existing progress; `not_needed` / `complete` → nothing new. No
  new primitives (existing Button), so no keyboard-pass gate; browser render
  check only.

**Verify:** re-run the Courthouse News clip end-to-end → `not_needed`, zero
`translate` rows in `apiLogs`. A genuinely French document → `offer`, still
zero translate rows until the button is clicked, then a normal run. A doc
with Analyze forced to fail → `unknown_language`, translate-anyway works.
Re-analyze a translated doc → status stays `complete`. Change the default
language → old translations flip to `offer`, no API calls fire.

## Phase 2 — Audio validation experiment (gate for Phase 3)

Zero new code. Pick 2 already-transcribed recordings in dev; run
`processing.runAnalyze` (bypass cache) so the existing text-in path analyzes
the stored timestamped transcript (`"Speaker [123s]: …"` page text) against
the audio schema variant (`time_seconds` TOC,
`convex/analyzePrompt.ts:508-529`).

Acceptance: TOC `time_seconds` monotonic and ≤ duration; entries within ~30s
of the actual topic shifts on spot-check seek; entities/language comparable to
the merged call's stored results. Record the comparison in the implementing
commit message. If it fails, the audio path keeps `understandDocument` and
only Phases 1/4/5 proceed — that's the point of gating.

## Phase 3 — Audio split

`runPipeline`, recording branch (`convex/processingStages.ts:572-628`):

- Delete the `understandDocument` call for recordings, the STT-precontext read
  (`:596-602`), and the `diarized` gate (`:604-608`, always false in practice).
- Order becomes: `transcribe(fileUrl)` (existing call at `:613`, URL-in-prompt
  is documented task behavior — keep) → ingest segments + page 0 (existing
  `:617-628`, `transcripts.ingestTranscript`) → `textStored = true` →
  `analyzeAndStore` with the transcript text, `audio: true`.
- "Re-transcribe" (`RecordingView.tsx` → `runFullPipeline`) now costs one task
  + one text-in call instead of two file-in calls. Must pass `bypassCache`
  (Phase 6).

## Phase 4 — Document / CSV split, delete `understand`

`runPipeline`, paged branch (`:572-591`, `:631-644`):

- The OCR shim becomes the main path: unconditional `ocrDocument(fileUrl)` →
  `ocrPrecontextToPages` → `ingestParseResults` (existing `:674-694`) →
  `analyzeAndStore` text-in. Delete the precontext-first branching and its
  2026-08-18 tripwire comments.
- CSV: keep local `csvSearchPages` (`:47-99`); analysis becomes text-in with
  the csv system-prompt variant — decouple the csv branch in
  `analyzePrompt.ts:237-238, 294-298` from `fileInput`.
- Unify persistence: `persistUnderstanding` (`:262-297`) and `analyzeAndStore`
  (`:304+`) must end as **one** consumer calling `metadata.saveMetadataResult`,
  `translations.setSourceLanguage`, `relationships.ingestGraph`,
  `metadata.setSuggestedEntityTypes`. One source of truth — the duplicated
  Analyze-schema consumer is exactly the drift class that broke clips before.
- Delete after `grep -rn` for other callers: `understandDocument`
  (`convex/interfaze.ts:781-819`), the `fileInput` branch of
  `understandingRequest` (`processingStages.ts:174-250`) and of the prompt
  lead (`analyzePrompt.ts:237-252`). Keep `ocrPrecontextToPages` (it parses
  the task payload) and every `interfaze.test.ts` pin. Keep
  `NativeMetadataOmissions`, `omitTableOfContents`, `askCreatedDate` — all
  input-agnostic.
- Images already ride the paged branch; no image-specific work.

Schema property order in `buildDocumentUnderstandingSchema` is behavior
(evidence → kind → … → dates). Phases 3–4 must not reorder fields; any move is
a separate before/after-measured change.

## Phase 5 — Re-run affordances

Backend:

- `processing.runFullPipeline` (`convex/processing.ts:159-184`): reject
  `mediaType === "webScrape"` with an error naming re-clip. Today nothing
  stops it from OCR-ing the archived HTML blob as if it were a scan; only a UI
  accident hides the path.
- New authed mutation `clips.reclip(documentId)`: ownership check, then
  schedule the existing `internal.backfill.reclipFromArchive`
  (`convex/backfill.ts:195`) — local re-parse of the stored HTML, then
  re-analyze. No API cost.

UI (`PipelineProgress.tsx`):

- Retry-scan affordance labeled per media type: "Re-OCR" (pdf/image),
  "Re-transcribe" (recordings — existing button in `RecordingView` stays),
  "Re-clip from archive" (webScrape → `clips.reclip`).
- "Re-run analyze…" dialog unchanged.

Annotation re-anchoring after re-OCR — the anchors were designed for this
(`convex/schema.ts:703-762`): transcript highlights anchor by `timeRange`
(re-transcription already re-anchors at paint via word timestamps), clip
highlights by `quote` (re-found in the rendered archive at paint), and PDF
highlights by `rects` in the page's own coordinate space — the page image is
unchanged by re-OCR, so the highlight keeps painting with zero work. The one
stale field is `blockIds` (references to replaced OCR blocks; recorded "so a
later pass can re-anchor or cite", not read at render). Repair it in the
re-OCR path after `ingestParseResults`: for each annotation on the document,
rewrite `blockIds` as the new blocks on `pageNumber` whose `bbox` intersects
the stored `rects` (same coordinate space by construction). Empty
intersection ⇒ `blockIds: []`, which clip rows already use. Guard: if the new
OCR reports different `pages.width/height` (provider DPI change), scale the
annotation rects by the ratio before intersecting. Leave `text` and
`sectionTitle` as created — the sectionTitle comment already establishes that
creation-time view is preserved deliberately.

## Phase 6 — Cache correctness

Interfaze's verified cache matches "the same file or a very similar prompt"
(docs/caching) — it is a feature for crash-retry replays and a hazard for
"give me a fresh answer" re-runs:

- `ocrDocument` and `transcribe` gain a `bypassCache` option (plumb the
  existing `x-interfaze-bypass-cache` support in `chatCompletion` through the
  task helpers). **User-initiated re-OCR / re-transcribe always bypasses** — a
  vcache hit would return the same bad extraction the user is trying to
  escape. First-run ingestion keeps the cache enabled (re-uploading an
  identical file replays free).
- `suggestedEntities.runExtraction` (`convex/suggestedEntities.ts:20-135`):
  after parsing, assert the response actually addresses every requested type;
  if not (a "very similar prompt" stale hit is indistinguishable from a
  refusal), retry once with `bypassCache: true`.
- Invariant to preserve everywhere: anything embedded in a prompt stays
  deterministically sorted, or byte-identical replays silently stop hitting.

## Phase 7 — Translate-task measurement (optional, last)

`translateUnits` (`convex/interfaze.ts:581-628`) pays full-model prices;
Interfaze exposes `translate` as a dedicated task with a **fixed** output
shape that cannot carry the stable-ID batch protocol. Before any migration:
run one real page batch through `task: "translate"`, read the actual output
shape, and compare billed cost in `apiLogs`. Migrate only if the shape maps
onto per-unit IDs (or per-unit calls are ~free). With Phase 1's prompt-only
semantics every run is an explicit user click, so volume is low and this is
deliberately last and skippable — but the click-triggered run is the natural
place for the task if the measurement favors it.

## What is measured, when

- After Phases 3–4: per-doc cost from `apiLogs` (`operation` in
  `ocr`/`transcribe`/`analyze`), compared against the merged-era medians
  (understand $0.27 / analyze $0.08 / ocr $0.002 / transcribe $0.13). Update
  the CLAUDE.md cost-shape section from the new measurements, per its own
  instruction.
- Translation: after Phase 1, every `translate` row in `apiLogs` must be
  traceable to a `translations.start` click. Any translate row without one is
  a regression, full stop.
- Cache: keep logging hit rate; expect first-run task calls to be misses and
  crash-retries to be hits.

## Per-phase verification

Every phase: `npx tsc -b`, edited-file lint (hook), then dev-deploy via
`npx convex dev` and process one document of the affected type end-to-end.
Full sweep after Phase 4: one scanned PDF, one digital PDF, one clip, one
recording — checking `apiLogs` rows, entity click-to-first-mention on each
viewer, TOC (page-based and time-based), and translation status per Phase 1's
matrix. No new focus-managing UI is introduced, so the keyboard pass is not
the gate; the render check is.

## Commit plan

Straight to `main`, one phase per commit (Phase 1 may be two: gate + UI).
Deploy backend after each phase (`npx convex dev`); frontend deploy
(`npm run deploy`) only for Phases 1e/5. Phases 1, 2, and 5–6 are independent
of the split itself and safe to ship even if Phase 2's experiment stalls the
audio migration.

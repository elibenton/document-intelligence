# Haystack

Upload documents — PDFs, DOCX, images, CSVs, audio/video, web clips — and the app
reads them: OCR + layout, a structured understanding pass, entity extraction,
translation, and a hybrid (keyword + vector + entity-graph) search that answers
questions with citations that deep-link back into the page they came from.

This README is written for someone who just cloned the repo. Read it top to
bottom once; after that, the "Where things live" table is the part you'll come
back to.

---

## 1. Run it locally

Prerequisites: Node 20+, and a [Convex](https://convex.dev) account.

```bash
npm install
```

Two processes, two terminals. Convex first (it generates types the frontend
imports):

```bash
npx convex dev
```

```bash
npm run dev
```

`npx convex dev` will prompt you to create/link a deployment and will write
`CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL` into `.env.local`. It then watches
`convex/` and pushes on save — **leave it running**, or your backend changes
won't exist.

### Secrets

Backend secrets live in the Convex deployment, not in `.env.local`. Set them
from the dashboard (`npx convex dashboard` → Settings → Environment Variables)
or the CLI:

```bash
npx convex env set INTERFAZE_API_KEY sk-...
```

| Variable | Required? | What breaks without it |
|---|---|---|
| `INTERFAZE_API_KEY` | **Yes** | All document AI: OCR, analyze, extract, transcribe, search synthesis |
| `GEMINI_API_KEY` | No | Semantic search leg is skipped; search still runs on full-text + entity graph |
| `CLIPPER_API_KEY` | No | The browser extension's `/clip` HTTP endpoint (`convex/http.ts`) |

Frontend-visible values (`VITE_*`) go in `.env.local` and are baked into the
bundle — never put a provider key there.

### Other commands

```bash
npm test         # vitest, pure-logic unit tests only
npm run lint
npm run build    # tsc -b && vite build
npm run deploy   # publish the frontend to Convex static hosting
```

**Deploying is not git.** `npm run deploy` publishes the built frontend;
`npx convex dev` pushes backend functions and schema. Pushing a commit deploys
nothing. Commits are atomic and go straight to `main` — no feature branches, no
PRs.

### Checks that run without you

`src/` lints clean, and `npx tsc -b` and `npm test` (176 tests, well under a
second) pass. Don't read a repo-wide lint count as a pass/fail gate, though: it
moves whenever a second process is writing to the tree. The gate is that the
file *you* changed lints clean.

If you use Claude Code, one hook enforces exactly that. `.claude/settings.json`
runs `.claude/hooks/lint-edited-file.sh` after every file write; it lints the
single `.ts`/`.tsx` file that just changed and hands back any error. That is
what makes the design-system fence in `eslint.config.js` — the rules that stop a
hand-rolled dialog or an off-scale `text-[11px]` — fire while the code is being
written rather than at build time. Editing outside this repo, non-TypeScript
files, and `convex/_generated/` are all no-ops. Nothing here is required to
build or run the app; delete the hook block and everything still works.

It calls three things. `eslint` is a devDependency, so `npm install` covers it.
`jq` and `node` are not in the project: `jq` ships with macOS at `/usr/bin/jq`,
and `node` may not be on the PATH a hook inherits at all — if you use a version
manager (mise, nvm, asdf), node lives outside the default PATH and eslint's
`#!/usr/bin/env node` shim fails. The script prepends the usual shim
directories to cover that. If it still can't find a tool it exits 0 and lets the
edit through: a toolchain problem should never block your work, so a broken hook
degrades to no hook. On Linux, or if `jq` is missing, `brew install jq` /
`apt install jq` restores it.

---

## 2. The mental model

Three things to internalize before reading code:

**Convex is the whole backend.** No REST API, no server you run. `convex/*.ts`
exports functions; the React app calls them by typed reference
(`api.documents.list`). Queries are *reactive* — a component using
`useQuery(api.documents.list, {...})` re-renders automatically when the
underlying rows change. That's why the pipeline UI has no polling anywhere: the
backend writes status to a row, and the screen updates.

Three function flavors, and the difference matters:

| | Runs where | Can do |
|---|---|---|
| `query` | Transactional, cached, reactive | Read the DB |
| `mutation` | Transactional | Read + write the DB |
| `action` | Non-transactional | `fetch`, external APIs — **no direct DB access**, it calls queries/mutations |

Anything touching an AI provider is therefore an `action`. Files ending in
`Node.ts` (`processingNode.ts`, `metadataNode.ts`, `searchNode.ts`, …) carry
`"use node"` at the top because the Interfaze SDK needs the Node runtime; their
non-Node halves (the mutations that persist results) live in the sibling file
without the suffix. That pairing is a deliberate, repeated pattern — not
accidental duplication.

**Interfaze is the document AI provider.** One call returns both a model answer
*and* a `precontext` array with raw OCR (sections → lines → words, with bounding
boxes and confidence). That geometry is what powers the selectable text layer,
entity highlighting, and citation deep-links. `convex/interfaze.ts` is the only
place that talks to it; it also owns cost logging (`apiLogs`, `apiUsageTotals`)
and maps provider errors onto UI-facing `FailureCode`s.

Because it is the only door, it is also where measurement lives: every call
stamps `finishReason`, `promptHash`, `outputHash`, `errorCode` and `buildSha`
onto the log row it was already writing, so production traffic doubles as the
benchmark corpus at zero extra cost. Add new metrics there rather than in a
bench script — see [CLAUDE.md](CLAUDE.md). `apiLogs` detail expires after 30
days (`convex/crons.ts`); lifetime spend lives in `apiUsageTotals`, which is
never pruned.

**Read the rules before touching AI code.** [CLAUDE.md](CLAUDE.md) lists
verified Interfaze constraints (extra calls are a last resort; design for the
cache; size ceilings are per *transport*, and ours is the 20MB one). [docs/pdf-edge-cases.md](docs/pdf-edge-cases.md)
documents the big one: **Interfaze does not OCR images embedded inside a PDF —
it reads the text layer and nothing else.** A scanned PDF comes back empty, and
re-encoding won't save it. That single fact explains most of the preflight code.

---

## 3. What happens when you drop a file in

```
GlobalDropOverlay (drag, paste) / AddFilesButton (file picker)
   └─ UploadProvider (src/components/upload/UploadProvider.tsx)
        ├─ preflight in the browser  ── pdfPreflight.ts / audioPreflight.ts
        │   (is there a text layer? too many pages? needs transcoding?)
        │   Problems that only degrade the result become warnings, not blockers —
        │   so a later empty scan is interpretable instead of mysterious.
        ├─ upload bytes to Convex storage (upload.generateUploadUrl)
        └─ upload.createDocument  →  documents row, status "uploaded"
                └─ processing.runFullPipeline
```

The overlay keeps holding the file after `createDocument`: it watches
`documents.ingestStates` and only releases the card when the document reaches
`completed` or `failed`. Until then the library filters that document out
(`heldDocumentIds`), so a file is in exactly one place at a time.

From there the pipeline is a chain of **stages**, each one a job row in
`processingJobs` and a workpool task:

| Stage | Where | What it does |
|---|---|---|
| `parse` | `processingNode.runDocumentUnderstanding` | One whole-file Interfaze completion: OCR + object detection + structured analysis. Its precontext becomes `pages`, `blocks`, `detections`. |
| `analyze` | `processingNode.runAnalyze` | Title, kind, category, date, table of contents, suggested extractions. Web clips take this path too. Prompt is user-editable — see `analyzePrompt.ts`. |
| `rename` | *(recordings only)* `renameNode.runRenamePass` | Writes `displayName` from the transcript. Documents don't need it — Analyze returns `display_title` directly. |
| `extract` | `processingNode.runExtract` | Pulls entities/answers per the suggested template → `extractions`, `entities`, `mentions`, `relationships`. Auto-runs once Analyze lands; there is no review gate. Re-run with edited roles from the extract dialog in `PipelineProgress`. |
| `transcribe` | `processingNode.runTranscribe` | The audio/video branch, taken instead of `parse` → `transcriptSegments`. |

Two independent workpools (`convex/convex.config.ts`): `processingWorkpool` for
AI stages, `renderWorkpool` for page derivatives. Keeping them apart means page
rendering never queues behind an Interfaze backlog, and "pause processing" —
which drives `maxParallelism` to 0 pool-wide — doesn't freeze the viewer too.

Pool parallelism is threaded through each enqueue rather than set on the
constructor. Workpool config is global and last-write-wins per enqueue, so an
enqueue carrying a constructor default would silently resume a paused queue.

**Terminal state comes from the pool, not a timer.** A Convex action killed at
the 10-minute limit never runs its own `catch`, which would otherwise strand a
document in `parsing`. Both pools pass an `onComplete`
(`processing.jobComplete`, `pageImages.renderJobComplete`), called on success,
failure and cancellation. A stage's own `catch` still writes its own failure —
that path has a real message and a `FailureCode` — and `onComplete` won't
overwrite an already-terminal verdict. A new stage passes
`{ documentId, stage }` to `processingEnqueueOptions`.

### Rendering, separately

`renderPages.ts` extracts **native PDF text geometry** server-side (~10ms/page).
It deliberately does *not* rasterize — page images are drawn client-side by
pdf.js (`PdfPageCanvas.tsx`) from the original file, because server-side canvas
spiked memory ~380MB/page and got the action killed. Commits are versioned
(`rendererConfig.RENDERER_VERSION`) so an upgrade is resumable and a retry skips
already-done pages.

DOCX takes the same path: `docxRender.ts` lays out pages to produce
`nativeBlocks`, and needs the *layout*, not pixels. Nothing stores page images;
render resumability comes from `pages.geometryVersion`.

### Search

`convex/search.ts` has two tiers. `suggest` is a cheap reactive query for
typeahead. Deep search inserts a `searches` row and streams its progress through
that row (planning → searching → synthesizing → completed), so the UI is just a
subscription. The retrieval is three parallel legs — full-text BM25, vector
(Gemini embeddings, skipped when no key), and entity graph — fused with
reciprocal rank fusion, then synthesized with `[n]` citations that deep-link into
the viewer.

---

## 4. Where things live

```
convex/            backend: schema, queries, mutations, actions
  schema.ts        ← START HERE. 24 tables, heavily commented with the *why*
  interfaze.ts     the only Interfaze client (+ cost logging, error mapping)
  processing.ts    stage orchestration, job rows, watchdogs (default runtime)
  processingNode.ts  the stages themselves ("use node")
  ingest.ts        turning provider output into rows
  search.ts        suggest + deep search; searchNode.ts does the LLM calls
  renderPages.ts / pageImages.ts   page text geometry + derivatives
  http.ts          public HTTP endpoints (the /clip webhook)
  _generated/      DO NOT EDIT — written by `npx convex dev`
    ai/guidelines.md  ← read this before writing Convex code
src/
  pages/           one file per route (see src/App.tsx)
  components/
    documents/     upload, cards, pipeline progress, review dialog
    viewer/        the reader: canvas, overlays, highlights, TOC
    entities/ search/ settings/ recordings/ ui/
  hooks/useUpload.ts
  lib/             pure helpers — preflight, geometry, types (this is what's tested)
extension/         browser web-clipper, posts to /clip
docs/              findings worth keeping: PDF edge cases, provider bug reports

CLAUDE.md          principles + gotchas for anyone (human or agent) writing here
AGENTS.md          → symlink to CLAUDE.md. One file, two names; edit CLAUDE.md
.claude/
  settings.json    hooks (see "Checks that run without you" above)
  hooks/           the hook scripts themselves
  agents/ skills/  hand-written: the ui-reviewer agent, the ui-component skill
  skills/convex-*  → symlinks into .agents/skills/, written by
                     `npx convex ai-files install`. Don't hand-edit; reinstall
.agents/skills/    the real files those symlinks point at
```

Routes (`src/App.tsx`): `/` projects → `/p/:projectId` library → `/documents/:id`
viewer, plus `/entity/:slug`, `/search`, `/settings`.

### The data model in one paragraph

`projects` contain everything. A `document` has many `pages`; a page has `blocks`
(lines/words with boxes), `detections` (graphics) and
`pageTranslations`. Extraction produces `entities`, linked to documents through
`mentions` (which carry the page + box, so a highlight can be drawn), and
`relationships` between entities. `processingJobs` tracks stage state,
`apiLogs`/`apiUsageTotals` track spend, `searches` holds one deep-search run.
Read the comments in `convex/schema.ts` — they explain the reasoning behind the
shapes, which is the part you can't infer from the fields.

---

## 5. Conventions worth copying

- **Comment the *why*, not the what.** The existing comments explain why the
  render pool is separate, why streaming is banned, why `name` is never
  overwritten. Match that; don't narrate code.
- **Provenance is never destroyed.** `documents.name` is the filename it arrived
  with and is never overwritten; `displayName` is the AI/human title layered on
  top, with `displayNameSource` so an AI pass can't clobber a human edit.
- **Degrade, don't crash.** No Gemini key → search drops a leg and says so. Bad
  provider output → a machine-readable `errorCode` the UI can render as a
  specific state, not a raw error string.
- **Nothing silently disappears.** Skipping the review queue is recorded and
  stays flagged in the library.
- **Tests cover pure logic.** `npm test` runs vitest over things like
  `pdfPreflight`, `pdfTextGeometry`, `docx`, and Interfaze response parsing —
  no live API calls. If you're writing something worth testing, make it a pure
  function in `src/lib/` or a non-Node Convex module.
- **Always run `npx convex dev`** while working. Editing `convex/` without it
  means the types the frontend imports go stale and errors show up in the
  wrong place.

## 6. First tasks to get oriented

1. Read `convex/schema.ts` end to end. It's the best-documented file here.
2. Upload a text-layer PDF and watch `PipelineProgress.tsx` — then upload a
   scanned one and see the preflight warning fire.
3. Trace one query from `src/pages/DocumentPage.tsx` back to its Convex function.
4. Read [docs/pdf-edge-cases.md](docs/pdf-edge-cases.md) — it's the empirical
   ground truth the preflight logic is built on.

# Scan via precontext — plan

**Status:** harness built and validated. Waiting on the corpus.
**Streaming: dropped.** Parsing precontext from a normal completion is enough,
and streaming carried real regressions (see §1). Not revisiting unless latency
data forces it.

Scope: the **mechanism** by which Scan gets its OCR and object geometry. The
Analyze feature set (nested TOC, hierarchical types, split suggestions,
extraction suggestions) is a separate plan; this one only makes room for it.

---

## 1. Why streaming is out

Read from `node_modules/interfaze/dist/index.js`:

- Precontext is inline in `delta.content`, wrapped in `<precontext>…</precontext>`
  (`:265`, `:284`). Reachable early via `create({ stream: true })`, which returns
  the raw unwrapped OpenAI stream (`:404`).
- But streamed completions **hardcode `vcache: false`** (`:247`), and streamed
  `usage` only exists if `chunk.usage` arrives, which needs
  `stream_options: { include_usage: true }` and is unverified for Interfaze.

`apiLogs`, the sharded `apiUsageTotals`, the settings usage page and
`providerHealth` all hang off `res.usage` and `res.vcache`. Streaming would log
every scan as `costUsd: 0, cacheHit: false`. The progressive-delivery win was
not worth paying for with the cost ledger. **Decision: non-streaming.**

---

## 2. What the first bench run found

One synthetic 3-page born-digital PDF, two variants. Both findings are real and
neither was predicted.

### 2.1 A live production bug in `ocrToPages`

The `full` variant (whole-file completion, the current production shape)
returned the OCR precontext **twice** — two entries, identical dimensions,
identical section counts, each containing all three pages.

`ocrToPages` (`convex/interfaze.ts:587`) branches on `ocrs.length > 1` and
assumes *one entry per page*. So it mapped:

| | result |
|---|---|
| page 0 | all 3 pages' sections merged, 99 blocks, height 4752 (should be 1584) |
| page 1 | the same duplicate content again |
| page 2 | **empty** |

Text fidelity against the native text layer: **33.3%** — exactly the 1-of-3 you
would expect. Every bbox on those pages is ~3× off vertically, because the
stacked height was never divided.

This is shipping today. Any document where Interfaze repeats the OCR precontext
gets merged, duplicated, and truncated page text plus wrong geometry — silently,
with no error.

### 2.2 The `task-ocr` path is correct, and 96× cheaper

| variant | time | cost | ¢/page | fidelity | pagination |
|---|---|---|---|---|---|
| `full` | 20.3s | $0.2011 | 6.70 | **33.3%** | broken (§2.1) |
| `task-ocr` | 2.9s | $0.0021 | 0.07 | **100.0%** | correct |

`task-ocr` returns one OCR result with `total_pages: 3`, `height: 4752` (the
*stacked* height) and 3 sections. That takes the `sections-as-pages` branch,
which divides `4752 / 3 = 1584` — and is right. The heuristic is load-bearing
and currently correct, but it is still inference, not reported data.

**Caveat before over-reading this:** one synthetic document, and `full`'s cost
includes generating the analysis that `task-ocr` never does. The 96× is not the
apples-to-apples number. The fidelity gap and the pagination bug are apples to
apples, and those are the ones that matter.

### 2.3 The checkers needed fixing too

The first run reported 786 geometry violations. All false: word boxes overhang
their line box by ~1px on descenders, and a purely relative 2% slack gives a
26px line only 0.5px of tolerance. Fixed with a 2px floor, mirroring
`convex/renderPages.ts`. Re-scored offline: **0 violations, both variants.**

Which is why `--reanalyze` exists — see §5.

---

## 3. Design

### 3.1 Scan

One **non-streaming** call per document. OCR and object geometry arrive via
`precontext`; the structured output carries analysis only and **never echoes
page text**.

Open question the corpus decides: whether Scan uses `task: "ocr"` (cheap,
correct pagination, no object detection) plus a separate steered vision call, or
one full completion (both specialists in one call, but §2.1 must be fixed
first). §2.2 currently favours splitting them; real documents may not agree.

### 3.2 Fix `ocrToPages` — prerequisite for everything

Before any of this ships, the branch logic needs to stop guessing:

- Detect duplicate OCR entries (identical dimensions + section counts) and
  collapse to one instead of treating them as pages.
- Only take `per-result` when entry count equals `total_pages`.
- Keep `sections-as-pages` — it is correct — but assert
  `sections.length === total_pages` and fail loudly when it doesn't hold.
- Never silently produce empty pages. A page with no text after a successful
  OCR is a bug, not a blank page.

`scripts/lib/diagnose.ts` already detects all of these read-only; the fix ports
that logic into production.

### 3.3 The rest

| Change | Detail |
|---|---|
| Drop `pages[]` from the output schema | `processingNode.ts:106` requires verbatim page text while `maxTokens` is 8192. Anything past ~15pp truncates, `JSON.parse` throws, and the precontext path silently carries the load. |
| Delete `structuredContentToPages` | Nothing left to parse. Its 3 tests go too. Intentional loss of a safety net — it produced geometry-less pages, which fails Scan's whole promise. Replace with a loud failure when precontext has no `ocr` entry. |
| Detection geometry from precontext | Add `detectionPrecontextToDetections`, reusing `boundsToBbox`. Prefer it; fall back to `structuredDetections`. If the corpus shows precontext geometry is reliable, delete `structuredDetections` (`processingNode.ts:244`) and its coordinate guessing. |
| Persist raw precontext | `documents.rawOcrStorageId` → `_storage`. Makes future changes to flattening re-derivable for free, which matters more than usual given there is no re-scan. Clean up on delete. |
| Per-page cost telemetry | `apiLogs.pages`, so the settings page can show ms/page and $/page. |
| Size guard | Two ceilings, neither measured: the 5-minute request cap, and 20MB — the [docs](https://interfaze.ai/docs/limits) say URL-referenced files get 80MB, our own comment at `interfaze.ts:1022` says a URL in a file part gets 20MB. **Corpus item 02 settles it.** Until then, pre-flight on page count and bytes rather than dying at the 9-minute watchdog. |

### 3.4 Extract, separately

Independent of all the above and worth doing first: Extract currently re-uploads
the whole PDF on every run (`extractionSource` → `fileUrlContent`), so four
extraction prompts means four full OCR passes. Switch to text-in.

Note `LIMITS.maxInlineTextBytesPerFile` is 250,000 and our
`MAX_INLINE_TEXT_CHARS` is 200,000 — a 500-page document's text exceeds both, so
this needs chunking, not just a swapped argument.

---

## 4. The harness (built)

```
scripts/scan-bench.ts        CLI: run variants, score, append CSV, save raw
scripts/lib/pdf.ts           offline ground truth + rasterization (pdfjs)
scripts/lib/checks.ts        geometry invariants + text fidelity
scripts/lib/diagnose.ts      heuristic-fire telemetry
scripts/make-sample-pdf.ts   synthetic born-digital PDF for self-test
test-corpus/                 drop zone (gitignored), README with the axes
```

Variants: `full`, `full-legacy` (today's schema, the A/B baseline), `task-ocr`,
`per-page` (rasterize locally, one OCR task per page image).

```bash
npm run bench -- --dry-run       # ground truth only, no API calls, no cost
npm run bench                    # full + task-ocr
npm run bench -- --variant=all
npm run bench -- --reanalyze     # re-score saved runs offline, free
```

Validated end to end: ground truth, rasterization, both API variants, CSV, raw
capture, offline re-scoring.

---

## 5. What we measure

| Check | Pass condition | Why it earns its place |
|---|---|---|
| **Page-count fidelity** | OCR page count == pdfjs page count | `ocrToPages` infers pagination three ways. §2.1 is what happens when it guesses wrong. |
| **Text fidelity** | ≥98% word agreement vs the native text layer | The only measure of OCR *accuracy* rather than plumbing, and free — born-digital PDFs carry their own oracle. Caught §2.1 immediately. Gated on painted text, since a hidden OCR layer is someone else's OCR and proves nothing. |
| **Geometry invariants** | 0 violations | In-page, non-zero area, words inside their line (2px floor), left-to-right order, confidence ∈ [0,1]. These are exactly what makes viewer overlays land wrong. |
| **Heuristic-fire telemetry** | branch reported, not inferred | Names which `ocrToPages` branch fired, whether page height was divided, whether `coordinateScale` corrected an axis, and whether OCR entries were duplicates. This is the evidence for or against per-page OCR. |

`--reanalyze` re-runs all of these over saved precontext with no API calls, so a
checker bug costs nothing to fix. Given §2.3, that is not a hypothetical.

---

## 6. Corpus

Eight axes, one good document each, in `test-corpus/` (gitignored). Full table
in `test-corpus/README.md`. Priority order given what §2 already showed:

1. **`01-born-digital`** — the oracle. Only row that measures OCR accuracy.
2. **`02-large`** (~150pp, and one >20MB) — settles the size-ceiling conflict.
3. **`07-concatenated`** — most likely to reproduce §2.1 on a real file.
4. **`03-stamped`** — does one call really yield both `ocr` and
   `object_detection` precontext, or does the router pick one?
5. `04-poor-scan`, `05-spanish`, `06-rotated`, `08-tables`.

Partial corpus is fine; the bench runs whatever is there.

---

## 7. Regression tests

Raw captures from §6 become checked-in fixtures in
`convex/__fixtures__/precontext/`. Real precontext, not hand-written guesses.

1. **`ocrPrecontextToPages` against every fixture** — page count, text present,
   geometry invariants. This function has never had a test against real
   precontext; the current tests only cover the fallback we're deleting.
2. **The §2.1 duplicate case, pinned.** Two identical OCR entries with
   `total_pages: 3` must yield 3 correct pages, not 2 duplicates and a blank.
3. **`detectionPrecontextToDetections`** — labels normalized, bboxes clamped,
   page mapping correct.
4. **Stacked-height division** — `sections-as-pages` with `height = n × pageHeight`
   yields correct per-page dimensions.

---

## 8. Sequencing

| # | Step | Status |
|---|---|---|
| 1 | Harness | ✅ done |
| 2 | Corpus (3 real PDFs) | ✅ done |
| 3 | Bench run, read the CSV | ✅ done — see §2 and §10 |
| 4 | Fix `ocrToPages` (§3.2) + tests | ✅ done |
| 5 | Scan via `task: "ocr"`, Analyze split out (§3.3) | ✅ done |
| 6 | Extract text-in (§3.4) | ✅ done |
| 7 | Object detection needs its own vision pass | **open** — see §11 |
| 8 | Per-page fallback above the size threshold | **open** |

## 9. Measured result

Per document, after the change (12-page born-digital PDF):

| Stage | Call | Tokens in/out | Cost | Time |
|---|---|---|---|---|
| Scan | `task: "ocr"` | — | $0.0021 | ~10s |
| Analyze | text-in completion | 18,224 / 993 | $0.0308 | 8.7s |
| Extract | text-in completion | 17,412 / 270 | $0.0271 | 5.9s |

**≈$0.06 end to end**, against $0.20–$0.75 for the single `full` call that
previously did Scan and Analyze together — and that call produced broken OCR.
Scan alone went from 147s to 10s on a 5-page scan. Every *additional* extraction
is now $0.027 instead of a full re-OCR of the document.

Verified through the UI: 12/12 pages, 25,881 characters, and a search for text
that appears only on page 12 returns exactly one correct match.

## 10. Why `task: "ocr"` and not the full completion

Measured repeatedly on the same file, the full model's OCR **precontext** is
non-deterministic:

| Run | Result |
|---|---|
| bench A | 2 identical OCR entries → 10 blank pages, 6.8% fidelity |
| bench B | 7 entries for a 12-page file → 5 blank pages, 16.7% |
| production | all 12 pages collapsed onto page 1 |
| `task: "ocr"` | **12/12 pages, 0 blank, 96.5% — every run** |

Transport is not the variable. base64, `inputs.file(url)`, and bare-URL-in-text
all return byte-identical results with `task: "ocr"`; URL-in-text merely costs
11× more ($0.0238 vs $0.0021), so `inputs.file(url)` stays.

The full model's *structured output* is fine — it is specifically the OCR
precontext that is unreliable — which is why Analyze remains a completion.

## 11. Known regression

Graphic objects (signatures, stamps, seals, redactions) are no longer detected.
They came from the full call's structured output; Analyze is now text-in and
cannot see the page. Asking a text-only call for them would just invite it to
infer a seal from the word "seal", which is the confabulation the comment at
`interfaze.ts:1022` already warned about.

They need a dedicated steered vision call. That call pays the vision pipeline
over the whole file — roughly $0.27 for a 12-page document on current numbers —
so it is worth deciding whether objects justify quadrupling per-document cost,
or should be opt-in per document kind.

---

## 9. Open questions

1. **Does one call reliably produce both `ocr` and `object_detection`
   precontext?** If the MoA router picks one specialist per call, objects need
   their own call and "one file touch" becomes two. Corpus item 03.
2. **Which size ceiling binds first** — 5 minutes, 20MB, or 80MB? Item 02.
3. **How often does the §2.1 duplicate-entry shape occur** on real documents
   versus the synthetic one? Determines whether `task-ocr` + a separate vision
   call beats one full completion.
4. **Is `sections-as-pages` division always correct**, or does it break when
   pages have differing heights (mixed portrait/landscape)? Item 06 probes it.

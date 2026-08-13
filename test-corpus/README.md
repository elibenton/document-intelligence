# Scan bench corpus

Drop PDFs in this directory and run:

```bash
npm run bench
```

PDFs here are **gitignored** — real documents never get committed. So are the
results. Only this README is tracked.

## Naming

Prefix with the axis it covers so results sort sensibly and it's obvious what
each row is testing:

```
01-born-digital.pdf
02-large-500pp.pdf
03-stamped.pdf
04-poor-scan.pdf
05-spanish.pdf
06-rotated.pdf
07-concatenated.pdf
08-tables.pdf
```

Anything is fine — the bench reads whatever `*.pdf` it finds. The prefixes are
for us.

## What each axis proves

| Prefix | Document | What it tests |
|---|---|---|
| `01-born-digital` | Digital PDF with a real text layer, 5–10pp | **Free OCR oracle.** The embedded text is ground truth, so this is the only row that measures OCR *accuracy*. Also the control for the native-text short-circuit. |
| `02-large` | ~150pp, and separately >20MB | Which ceiling binds first: the 5-minute request cap, or the file-size limit. Settles a conflict between the Interfaze docs and our own code comment. |
| `03-stamped` | Stamps, seals, signatures, redactions | Whether object detection is steerable to these labels, and whether `ocr` and `object_detection` both land in one call's precontext. |
| `04-poor-scan` | Skewed, low-DPI, handwriting | Confidence values, and whether bad lines are dropped or hallucinated. |
| `05-spanish` | Spanish or mixed-language | That source text comes back untranslated. |
| `06-rotated` | 90°/180° pages | Whether the `coordinateScale` correction fires. |
| `07-concatenated` | Several documents in one file | Page-boundary handling now; split-boundary input later. |
| `08-tables` | Table-heavy or multi-column | Reading order — the weakest point of whole-file OCR. |

One good document per axis beats ten of the same kind. Partial corpus is fine:
the bench runs whatever's here.

## Commands

```bash
npm run bench -- --dry-run          # ground truth only, no API calls, no cost
npm run bench                       # full + task-ocr (the default pair)
npm run bench -- --variant=all      # adds full-legacy and per-page
npm run bench -- --variant=per-page --pages=20 test-corpus/02-large.pdf
npm run bench -- --bypass-cache     # force fresh provider runs
```

Start with `--dry-run`. It reads page counts, native text, and text-layer
visibility entirely offline — so you can confirm the files are what you think
they are before spending anything.

## Output

- `results/scan-bench.csv` — one row per document × variant, appended
- `results/raw/<doc>--<variant>.json` — full record including raw precontext

The raw JSON is the source for the checked-in regression fixtures in
`convex/__fixtures__/precontext/`.

## Reading the console output

```
03-stamped.pdf  12pp  2.4MB  native-text 0%  oracle no
   full        18.2s  1517ms/pp  $0.0413 (0.34¢/pp)  pages 12/12  geom 0/431  fidelity n/a (…)  [clean]
```

The bracket at the end is the heuristic verdict, and it's the one to watch.
`clean` means pagination came back reported rather than inferred. Anything else
— `page height DIVIDED`, `coordinate scale fired`, `multi-page doc collapsed` —
means `ocrToPages` is guessing, and that's the evidence for switching to
per-page OCR.

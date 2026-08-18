---
description: Read the failure ledger, diagnose the worst issues against the code, and write the reports back.
---

Triage Haystack's failure ledger: read what is actually breaking for users, work
out why against the source, and leave a written report on each issue.

`$ARGUMENTS` may name a limit (`3`), a state (`open`, `triaged`, `resolved`,
`ignored`), or a fingerprint. Default: the 3 worst `open` issues.

## Background

`convex/issues.ts` records one row per *distinct kind* of failure, from five
surfaces — `client` (the browser, before the bytes land), `pipeline`, `render`,
`provider`, and `crash`. Identical failures collapse onto one row by a
fingerprint over the scrubbed message (`convex/issueFingerprint.ts`), so `count`
is how often and `affectedOwners` is how many people.

Rank by people, not by count: one account bulk-uploading fifty broken files and
fifty accounts hitting one wall are the same `count` and completely different
problems. `listForTriage` already sorts this way — trust its order.

## Steps

0. **Pick your access path.** Two exist, and which one you have decides
   everything below:

   - **Convex MCP available** (running locally): use it. Get the deployment
     selector from `status`, and target **dev** unless told otherwise.
   - **No MCP** (running as a cloud routine): use the CLI, which reads
     `CONVEX_DEPLOY_KEY` from the environment and needs no `.env.local`. Run
     `npm ci` first so the checkout has its dependencies. Both reads and writes
     work, including internal functions:

     ```
     npx convex run issues:listForTriage '{"state":"open","limit":10}'
     ```

     If `CONVEX_DEPLOY_KEY` is unset, **stop and say so** — do not guess at the
     ledger's contents or report on an empty result as though it were good news.

1. **Read the queue.**

   `issues:listForTriage` with `{"state":"open","limit":10}`

   Prefer it over an ad-hoc query so the order you work in is the order the
   admin page shows.

2. **Pick.** Take the top N (default 3). Skip any whose `triage` exists and
   whose `count` has not grown since `triage.atCount` — that report still
   stands. Prioritise anything with `regressedAt` set: something believed fixed
   came back, and that is the most valuable row in the table.

3. **Diagnose each one against the source.** The row tells you `surface`,
   `stage`, `errorCode`, `fileKind` and three scrubbed samples. Read the code
   that produced it:

   | surface | where to look |
   |---|---|
   | `client` / `preflight` | `src/lib/pdfPreflight.ts`, `src/lib/audioPreflight.ts`, `src/lib/uploadTypes.ts` |
   | `client` / `upload` | `src/components/upload/UploadProvider.tsx` |
   | `pipeline` | `convex/processingStages.ts`, `convex/processing.ts`, `convex/relationships.ts` |
   | `render` | legacy surface — the server render pipeline is deleted; recent rows indicate a stale build |
   | `provider` | `convex/interfaze.ts`, `convex/interfazeLimits.ts`, `convex/interfazeErrors.ts` |
   | `crash` | the stack in the sample, then the component it names |

   Note the scrubbing: `<name>`, `<id>`, `<url>`, `<n>` are redactions, not the
   literal text. Do not conclude the URL was empty.

4. **Reproduce, only when it would change the answer, and only after asking.**
   A sample may carry a `documentId`, and the stored file is still there.
   Re-running the stage costs a real billable Interfaze call against the owner's
   budget, so **ask the user before any re-run** and say which stage and roughly
   what it costs (see the cost shape in CLAUDE.md — Analyze and Extract are ~88%
   of $0.066/doc). If they decline, say the diagnosis is inferred, not measured.

5. **Write the report.** Keep it short and specific — this is read in a
   `<details>` on `/admin/issues`, not published:

   - **What breaks** — one sentence, in the user's terms.
   - **Who it hits** — accounts affected, count, first/last seen, build.
   - **Why** — the actual mechanism, citing `file.ts:line`. If you could not
     determine it, say so plainly rather than guessing.
   - **Smallest fix** — what you would change, and what it would cost.
   - **Should it be classified?** Most of these should end in a new
     `FailureCode` in `convex/interfazeErrors.ts` (or a preflight code) plus the
     sentence the user should see instead of the raw provider string. That is
     the point of the loop: triage is supposed to *reduce* the pain, not just
     record it.
   - **Working as intended?** Some failures are correct behaviour (someone
     dropped a `.exe`). Say so, and set the state to `ignored` — that is the one
     state a recurrence never reopens.

6. **Write it back.**

   `issues:saveTriage` with `{"issueId":"<_id>","markdown":"<report>"}`

   This sets the state to `triaged` and stamps the count, so the row reopens by
   itself if the problem doubles. For a working-as-intended row use
   `issues:setState` with `{"issueId":"<_id>","state":"ignored"}` instead.

7. **Summarise for the user**: the top three pain points by accounts affected,
   what you changed the state of, and anything you could not diagnose.

## Rules

- **Do not fix anything.** This command diagnoses and reports. If a fix is
  obvious, put it in the report and let the user decide — a triage pass that
  edits code turns one reviewable change into a surprise.
- **`saveTriage` and `setState` are internal functions**, reachable with a
  deployment key (MCP or CLI) and not from any browser. `list` is the
  admin-gated twin the page uses; calling *it* with a deployment key fails,
  because there is no signed-in user — that is why the internal twin exists.
- **Prod is read-only through the MCP**, but a prod `CONVEX_DEPLOY_KEY` is not.
  When running as a cloud routine against prod, you are writing to production:
  `saveTriage` and `setState` only, never anything else.
- **Samples are already scrubbed.** Do not try to recover the original filename
  or URL, and do not paste a `documentId` into the report body — it is already
  on the row.

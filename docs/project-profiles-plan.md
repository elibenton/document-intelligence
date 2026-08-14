# Project profiles — plan

**Status:** approved, in build. Decisions settled 2026-08-14 — `citeproc`'s
CPAL/AGPL license accepted; the per-project vcache fragmentation accepted (a
document rarely lands in two projects); the four templates accepted as a
starting point to refine later; `documents.tags` confirmed out of scope.
`numeric` stays the existing numbered-source behavior — see §2.1.

Three things become per-project and are chosen once, in a new-project flow, from
a template the user can then edit forever in project settings:

1. **Document taxonomy** — `documentCategories` and `documentKinds`, both
   currently global rows.
2. **Entity types** — `projectEntityTypes`, already per-project; it only needs
   seeding and an editor.
3. **Citation style** — new. Numbered / Chicago / MLA / APA, feeding a
   deterministic formatter over bibliographic data that Analyze starts
   collecting.

---

## 0. What is *not* in scope, and why

- **`documents.tags`.** Analyze's 3–6 free-form lowercase topical tags have no
  vocabulary to configure — they are not the pills the taxonomy drives. Nothing
  here touches them. If "document tagging" meant these, say so; it is a
  different (and much smaller) feature.
- **Backfilling existing documents.** A taxonomy or citation change alters what
  *new* documents extract. Re-running every document in a project on a form
  submit is an unbounded API bill triggered by a dropdown — the same rule
  `projectEntityTypes` already states. Re-analyze stays a deliberate per-document
  or per-selection action, which already exists.
- **Per-project language / provider / usage settings.** Those are deployment
  facts. `/settings` keeps them; `/p/:slug/settings` is the new page.

---

## 1. Making the taxonomy project-scoped

### 1.1 What is global today

| Table | Scope now | Read by |
| --- | --- | --- |
| `documentCategories` | global, `by_key` | `analyzePrompt.forDocument`, `processingNode` (×2), `metadata.saveMetadataResult`, `DocTypePills`, `DocumentCategoriesSettings` |
| `documentKinds` | global, `by_name` | `processingNode` (×2), `metadata.saveMetadataResult`, `documents.ts:199,236`, `search.plannerContext`, `HomePage` bulk-tag popover |
| `projectEntityTypes` | **already per-project** | `relationshipsNode:222`, `DocumentPage` |

`documents.primaryCategory` stores the category **key**, and `documents.kinds[]`
stores kind **names**. Neither is a foreign key, so scoping the vocabulary tables
does not require touching a single document row — only the lookups that validate
against them.

### 1.2 Schema change (widen → migrate → narrow)

Convex rejects rows carrying undeclared fields and refuses a narrowing that
existing data violates, so this is three deploys, not one.

**Widen** (`schema.ts`):

```ts
documentCategories: defineTable({ ..., projectId: v.optional(v.id("projects")) })
  .index("by_key", ["key"])                       // dropped in the narrow step
  .index("by_project", ["projectId"])
  .index("by_project_and_key", ["projectId", "key"]),

documentKinds: defineTable({ ..., projectId: v.optional(v.id("projects")) })
  .index("by_name", ["name"])                     // dropped in the narrow step
  .index("by_project_and_name", ["projectId", "name"]),

documents: … .index("by_project_and_category", ["projectId", "primaryCategory"]),
// `by_primaryCategory` is dropped in the narrow step: a global index is a write
// cost on every document insert and answers a question nobody asks any more.
```

**Migrate** — `migrations:scopeTaxonomyToProjects`, following the
`backfillEntitySlugs` shape (paginated, self-rescheduling, idempotent):

- For each project, insert a copy of every unscoped `documentCategories` row.
  Keys are preserved verbatim, so every existing `documents.primaryCategory`
  still resolves.
- Kinds are derived rather than copied: walk `documents` by project, collect
  `kinds[]`, insert one row per (project, name). This is exact and drops kinds
  no document ever used — better than copying the global list into every
  project, which would hand a biology project the legal vocabulary on day one.
- Delete the unscoped rows only after both copies land.

**Narrow** — `projectId: v.id("projects")` required on both tables; drop
`by_key`, `by_name`, `documents.by_primaryCategory`.

### 1.3 Call sites

Every query/mutation in `documentCategories.ts` and `kinds.ts` takes
`projectId`. The threading is mechanical:

- `processingNode.runDocumentUnderstanding` and the Analyze retry already hold
  the document; read `document.projectId`.
- `metadata.saveMetadataResult` scopes both the `validCategories` set and the
  `kinds.upsert` call by `document.projectId`.
- `documents.ts:199,236` pass the document's project into `kinds.upsert`.
- `search.plannerContext` already has `projectId` — the `documentKinds` read at
  `search.ts:387` becomes an indexed project read instead of a `.take(50)`.
- `analyzePrompt.forDocument` reads the document's project.
- `DocTypePills` takes a `projectId` prop (`DocumentPage` and the library rows
  both have it).
- `documentCategories.remove` / `bySecondaryType` move to
  `by_project_and_category` on `documents`.

**Cost note:** the Analyze prompt embeds the category list and the kind-reuse
clause, so today two projects analysing similar documents can share a `vcache`
hit. After this they cannot — the prompt differs per project by construction.
That is the price of the feature, not a bug, but it will show up as a drop in
the cache-hit rate on the settings page and should not be mistaken for a
regression.

---

## 2. Citation style

### 2.1 The four options

| Key | Label | Backed by |
| --- | --- | --- |
| `numeric` | Numbered sources | today's `[n]` markers + source cards. No library. |
| `chicago` | Chicago (notes & bibliography) | `chicago-note-bibliography.csl` |
| `mla` | MLA | `modern-language-association.csl` |
| `apa` | APA | `apa.csl` |

Stored as `projects.citationStyle: v.optional(v.string())`; **absent means
`numeric`**, so there is nothing to backfill and existing projects keep behaving
exactly as they do now.

> "Normal footnotes" is read here as the existing numbered-source behavior. If it
> meant true footnote *notes*, that is a one-line change — `numeric` maps to a
> different CSL file — but Chicago notes-and-bibliography already is that style,
> so the two options would collapse into one.

### 2.2 The model does not format citations

The synthesis prompt keeps emitting `[1]`, `[2]`. Style is applied
**deterministically at render time**, client-side. Three consequences worth
stating plainly:

- No extra API call, and no added output tokens on search.
- Changing a project's style re-renders every *existing* answer correctly,
  because the stored answer never contained a formatted citation.
- The formatter is a pure function of stored data, so it is unit-testable with
  the vitest setup already here.

### 2.3 What Analyze has to start collecting

A bibliography needs facts the pipeline does not currently keep: container
title, publisher, volume/issue/pages, court/agency, docket number, DOI, URL.
Per the Interfaze rule, this rides along on the **existing** Analyze call as new
schema properties — not a new call, and not a second pass.

New `citation` object on the Analyze response (all strings, `""` when the
document does not state the fact):

```
citation: {
  type,                 // enum: article-journal | article-newspaper | book |
                        //   chapter | report | legal_case | legislation |
                        //   patent | webpage | manuscript | speech | dataset |
                        //   personal_communication | document
  contributors: [ { role: author|editor|translator, family, given, literal } ],
  container_title,      // journal, newspaper, website, or reporter
  publisher, publisher_place,
  volume, issue, pages, edition,
  number,               // report / docket / form number
  authority,            // issuing court or agency
  jurisdiction,
  genre,                // "Memorandum", "Deposition transcript", …
  doi, isbn, url
}
```

**Placement is a behavior change.** Property declaration order in
`buildDocumentUnderstandingSchema` is a reasoning chain (evidence → kind →
category → title → dates), and the title depends on no date being in context
yet. The `citation` object therefore goes **last**, after `additional`: nothing
before it moves, and the model writes it with the full analysis already in
context, which is exactly what bibliographic reasoning wants. It still gets a
before/after run on `test-corpus/` — a schema edit here is never free.

`CITATION_RULE` in `analyzePrompt.ts` carries the same bargain as `DATE_RULE`
and `PLACE_RULE`: read it off the document's own text, leave it empty otherwise,
declining is correct and expected.

**Deterministic fields are not asked for.** `issued` comes from
`documentDate`/`documentDatePrecision`; `URL` and `accessed` come from
`sourceUrl` and `uploadedAt` for web clips; the title falls back to
`displayName`. Asking the model for facts we already hold would be paying twice
for a worse answer.

**Cost:** an extra ~100–250 output tokens on a call that currently costs
$0.0308, so roughly +$0.0004–0.001 per document against a $0.066 doc — under
1.5%. Worth measuring on the corpus run rather than asserting.

Storage: `documents.citation: v.optional(v.object({…}))` — a real object, not a
JSON blob like `metadata`, because the UI renders and (step 6) edits individual
fields. Sanitizers mirror `sanitizeDocumentPlace`: trim, drop refusal words,
length-cap, drop the whole object when nothing survives.

### 2.4 The formatter

`citeproc` (citeproc-js) — the reference CSL implementation, zero dependencies,
~975 KB unpacked. `@citation-js/*` wraps this same engine and adds input parsing
we do not need, since we build CSL-JSON ourselves.

**License decision required.** `citeproc` is `CPAL-1.0 OR AGPL-1.0` — both
copyleft, and CPAL adds an attribution requirement to the UI. The CSL style
files are CC-BY-SA 3.0. For a private tool this is almost certainly fine, but it
is a deliberate choice, not a default. The alternative is hand-writing three
formatters, which is a losing game for Chicago in particular. **Confirm before
step 7 is built.**

```
src/lib/citation/
  cslItem.ts     Document row → CSL-JSON item. Pure, unit-tested.
  format.ts      lazy loadEngine(style) → { inText(item), bibliography(items) }
  styles/*.csl   vendored, imported with Vite `?raw`
  locales-en-US.xml
```

The engine and the ~250 KB of XML load through a dynamic `import()` only when
the project's style is not `numeric`, so the default path pays nothing.
`citeproc`'s `retrieveLocale` is synchronous, which is why the locale is bundled
as a raw string rather than fetched.

Rendered in two places:

1. **Source card header** (`ResearchEvidenceCarousel`) — the in-text form
   replaces "DocName · Page 4" for author-date styles.
2. **References list** under the answer — the style's own bibliography, sorted
   the style's own way.

`citationMarkdown()`'s `[n]` → `#citation-n` rewrite already gives us the anchor;
author-date styles rewrite the visible label at the same point.

A "Copy citation" affordance on the document page is a natural third home and is
listed as optional step 8 — it is not needed for the feature to work.

---

## 3. Templates and the new-project flow

`convex/projectTemplates.ts` — pure data, no server imports, imported directly by
both the wizard and the create mutation (`src/` already imports
`../../convex/_generated/api`, so the path works in both bundlers). One source
of truth; no query round-trip for a constant.

```ts
export interface ProjectTemplate {
  key: string; label: string; description: string;
  citationStyle: "numeric" | "chicago" | "mla" | "apa";
  categories: Array<{ key; label; description; color }>;
  entityTypes: Array<{ label; description }>;
}
```

Proposed set — **this list needs your input**, it is the part I am guessing at:

- **Investigative journalism** — the current four categories (legal, government,
  business, published) verbatim, `numeric`, entity types: none beyond the base
  two. This is today's behavior, so choosing it is a no-op.
- **Legal** — categories: pleadings, orders & judgments, discovery, contracts,
  correspondence, exhibits. `chicago`. Entity types: courts, matters.
- **Academic research** — categories: journal articles, books & chapters,
  preprints, datasets, theses, grey literature. `apa`. Entity types: methods,
  datasets.
- **Custom** — nothing seeded; the user adds categories and types themselves.

A "Biology" template distinct from "Academic research" is easy to add later —
templates are one const each — but I would not ship both until someone wants the
difference.

**Create flow.** `ProjectsPage`'s inline name form becomes a dialog
(`@/components/ui/dialog`, not a hand-rolled portal):

1. Name + description.
2. Template cards, one selected, each saying how many categories and entity
   types it brings.
3. The categories it will create, named.
4. Citation style, defaulted from the template and overridable.
5. Create.

**No inline editing of categories or entity types before creation**, which the
first draft of this plan called for. The ask was explicitly that these are
"adjustable after the fact in the project settings", and that editor already
exists — building a second one inside a create dialog would be a duplicate of
the harder kind, the kind that drifts. `projects.create` therefore takes
`templateKey` and `citationStyle` only; the `categories`/`entityTypes` override
arguments were written in step 4, found to have no caller, and removed.

Citation style is the one thing offered at creation: it is a single value rather
than a list, and it is the newest of the three concepts, so naming it here is
what tells a user it exists.

`projects.create` seeds `documentCategories`, `projectEntityTypes` and
`citationStyle` **in the same mutation** — one transaction, so a project can
never exist in a half-seeded state.

---

## 4. Project settings

New route `/p/:slug/settings` → `ProjectSettingsPage`, built on `PageShell`:

- Citation style (radio group with a live example rendered from a real document
  in the project, so the choice is legible).
- Document categories — `DocumentCategoriesSettings` moves here and takes a
  `projectId`. It is already the right editor; it is only in the wrong place.
- Entity types — a new editor over `projectEntityTypes`. Today they can only be
  created ad-hoc from the document page, and never listed or deleted from a
  settings surface.
- Link in from the project header on `HomePage`.

`/settings` keeps usage, API log, provider health, processing queue, default
language, and loses the categories section.

---

## 5. Commit sequence

Atomic commits, straight to `main`. Steps 1–3 are one migration in three
deploys; do not compress them.

| # | Commit | Status |
| --- | --- | --- |
| 1 | Widen taxonomy schema + `scopeTaxonomyToProjects` migration | **done** — migration ran 2026-08-14; 8 category and 25 kind rows scoped, no unscoped remnants. The migration function was deleted with the narrow: it queries for a state the schema now forbids, and can never run again. |
| 2 | Thread `projectId` through every category/kind call site | **done** |
| 3 | Narrow `projectId` to required; drop the three dead indexes | **done** — folded into 2 rather than deployed separately, because the data was already clean and the alternative was writing undefined-handling twice. |
| 4 | `projectTemplates.ts`, `projects.citationStyle`, seeding in `projects.create` | **done** — verified against the deployment: the legal template seeds 6 categories, 2 entity types and `citationStyle: "chicago"` in the creating transaction. Template categories carry no `key`; it is derived from the label by `documentCategories`' own slugify, which reproduces the four existing keys exactly. Project deletion gained a `taxonomy` phase — per-project categories, kinds and entity types had no owner and every deleted project would have stranded them. |
| 5 | New-project dialog with template picker | **built, not yet verified in the browser** — the auth gate landed from the concurrent auth work and the preview now requires a sign-in. Typecheck and lint clean. |
| 6 | `/p/:slug/settings` — citation style, categories, entity types | **built, unverified** — all three sections present. `projects.update` gained a validated `citationStyle`. The entity-type editor is the first place these can be listed or removed at all; before it, a type added from the document page was permanent and invisible. |
| 7 | Analyze `citation` block: schema, `CITATION_RULE`, sanitizers, storage | before/after corpus run |
| 8 | `citeproc` + CSL styles + `src/lib/citation` + rendering in search | |
| 9 | *(optional)* citation preview / edit / copy on the document page | |

The project settings page was pulled forward into step 2 on purpose: scoping
`DocumentCategoriesSettings` to a project made it unmountable on the app-wide
settings page, and leaving the only category editor unreachable between two
commits is worse than landing the page early.

## 5a. Moving a document between projects

Added mid-build (`convex/documentMove.ts`), because scoping things to a project
is what makes "this is in the wrong project" a fixable mistake rather than a
permanent one.

`documents.projectId` is one field, but three other things carry the project:

- **Denormalized ids** on `pages`, `pageTranslations` and `annotations`. Left
  stale, the moved document's pages keep answering the old project's searches
  and never answer the new one's.
- **The entity graph.** Mentions, roles and relationships are repointed onto
  same-named entities in the target project — matched on `slug`, created there
  if absent — with counts adjusted arithmetically the way `drainMentions`
  already does it. Source entities this document was the last evidence for are
  swept by the existing `sweepOrphanEntities`. No API call, nothing re-extracted.
- **The kind vocabulary**, registered in the target project.

`primaryCategory` is deliberately *not* rewritten: it is a key into a taxonomy
the target may not share, and guessing which of its categories the old one meant
is exactly the kind of invention this codebase avoids elsewhere. The pill falls
back to the kind alone and the dialog says re-analyzing is how to re-file it.

Two things worth remembering:

- **The drain paginates; it does not `take` the head repeatedly.** The deletion
  cascade can re-read the first batch because deleting a row removes it from the
  index. A move only patches, so the rows stay put — a `take` loop would either
  spin forever or stop early.
- **`starred` is not copied to the twin.** It is curation of one project's
  sidebar, and `sweepOrphanEntities` spares starred entities on purpose — so a
  copied star makes an empty twin permanently unsweepable. Found by round-tripping
  a real document and finding a 0-mention entity left behind.

Verified end-to-end on a live document chosen because all its entities were
shared with other documents, making the round trip lossless: counts went 5→4
mentions and 3→2 documents on the way out, the twin was created with 1 and 1,
and moving back restored the original entity exactly and swept the twin.

## 5b. Verification is currently blocked

The concurrent auth work has closed both verification routes this plan relied
on, and steps 5 and 6 are built but unseen because of it:

- **The browser preview** shows a landing page until someone signs in, and
  creating an account or entering credentials is not something the agent doing
  this work will do.
- **`npx convex run`** now fails with `Unauthenticated` — every query and
  mutation moved to `authedQuery`/`authedMutation`, so the CLI can no longer
  drive a function the way it verified the taxonomy migration and the document
  move earlier in this plan.

What that costs: steps 1–4 were each checked against real data (row counts
before and after, a round-tripped document, a seeded-then-deleted project).
Steps 5 and 6 have `tsc` and lint only. Step 7 must not be started under this
constraint — it changes what Analyze emits, it costs money per run, and a
before/after corpus diff is the entire point of it.

Unblocking needs one of: a signed-in preview session, or a way to run
authenticated Convex calls (a dev bypass, or a token the CLI can present).

## 6. Verification

- `npx tsc -b`, and `npm run lint` still at exactly 2 known errors in
  `src/components/viewer/`.
- Steps 5 and 6 are unverified until driven Tab / Shift-Tab / Enter / Escape
  with the focus ring visible at every stop and focus restored to the trigger.
- Step 7: run the three `test-corpus/` PDFs through Analyze before and after the
  schema edit, and diff `primaryKind`, `primaryCategory`, `displayName`,
  `documentDate`. The property-order rule says a field move is a behavior
  change; appending should be inert, and "should be" is why it gets measured.
- Step 8: `cslItem.ts` gets vitest coverage over the awkward cases — an
  organization as author (`literal`), a year-only `issued`, a legal case with an
  authority and no publisher, a web clip with `accessed`.
- Migration: confirm on the deployment that no `documentCategories` or
  `documentKinds` row is left with an absent `projectId` before step 3 pushes.

## 7. Decisions — settled

1. **`citeproc`'s CPAL/AGPL license** — accepted.
2. **Per-project vcache fragmentation** — accepted; a document rarely lands in
   more than one project, so the shared-hit case was mostly theoretical.
3. **The template set** — Investigative / Legal / Academic / Custom ship as
   drafted, to be refined against real projects rather than in the abstract.
4. **`documents.tags`** — out of scope, unchanged.
5. **"Normal footnotes"** — `numeric` is the existing numbered-source behavior.
   Chicago notes-and-bibliography covers true footnotes, so collapsing the two
   would lose an option rather than add one.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * How one list is currently being looked at: which properties show, how rows
 * group, filter, and order. Mirrors ViewConfig in src/lib/views/types.ts —
 * `visibleProperties`, `groupBy`, and the filter/sort property names are all
 * PropertyDef ids from the client-side registries, which is why nothing here
 * is an enum: the backend stores the configuration, it does not interpret it.
 *
 * Filter values are strings even for numbers and dates, so this stays a plain
 * object rather than a union of every value type; the property def that owns
 * the id parses them back.
 */
const viewConfigValidator = v.object({
  visibleProperties: v.array(v.string()),
  groupBy: v.optional(v.string()),
  groupSort: v.optional(v.string()), // "asc" | "desc" | "count"
  hideEmptyGroups: v.optional(v.boolean()),
  filters: v.array(
    v.object({
      property: v.string(),
      operator: v.string(),
      value: v.optional(v.string()),
      values: v.optional(v.array(v.string())),
    })
  ),
  sorts: v.array(
    v.object({
      property: v.string(),
      direction: v.string(), // "asc" | "desc"
    })
  ),
});

export default defineSchema({
  // Top-level workspaces. Everything (documents, entities, stories, searches)
  // lives inside exactly one project; a document copied to another project is
  // a separate row with its own extraction layer.
  projects: defineTable({
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    // How search answers cite their sources: "numeric" | "chicago" | "mla" |
    // "apa" (convex/projectTemplates.ts). Absent means "numeric", which is what
    // every answer has always rendered — so there is nothing to backfill, and a
    // project created before this existed behaves exactly as it did.
    //
    // Style is applied when an answer is *rendered*, never when it is written,
    // so changing this re-formats existing answers rather than stranding them.
    citationStyle: v.optional(v.string()),
    // The Better Auth user id of the owner. A `v.string()` and not a
    // `v.id("users")`: the user record lives in the component's tables, so
    // there is no `users` table in this schema to point at (docs/auth-plan.md
    // §7.1). Optional only until migrations:backfillProjectOwners has run —
    // an unowned project is readable by nobody, so the window is fail-closed
    // rather than fail-open.
    //
    // This is the only ownership field in the schema. Every other table
    // answers "who owns this?" by walking up to its project, at most two
    // ctx.db.get calls (convex/ownership.ts). Denormalising ownerId onto the
    // other 23 tables would be faster and would drift.
    ownerId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_createdAt", ["createdAt"])
    .index("by_owner", ["ownerId"])
    .searchIndex("search_name", { searchField: "name" }),

  // How this project's two lists are currently configured, plus the width the
  // user dragged between them. One row per project rather than one per list:
  // the page needs all of it at once, so a single document is a single
  // subscription and a single atomic patch. An absent row means defaults, so
  // there is nothing to backfill.
  projectViews: defineTable({
    projectId: v.id("projects"),
    /** The Library's share of the split, 0-1. Clamped by the client. */
    splitRatio: v.optional(v.number()),
    library: v.optional(viewConfigValidator),
    entities: v.optional(viewConfigValidator),
  }).index("by_project", ["projectId"]),

  // Uploaded sources: PDFs, CSVs, images, audio/video recordings, and web clips.
  documents: defineTable({
    // Optional only for pre-project rows; backfilled, and all new rows are stamped
    projectId: v.optional(v.id("projects")),
    // The name the file arrived with (upload filename, clip title). Never
    // overwritten — it's provenance, and the only handle the user recognizes.
    name: v.string(),
    // Descriptive title shown above `name` in the UI. Written by the rename
    // pass once the metadata pass has established what the document actually
    // is (convex/rename.ts), or typed by the user in the identity menu.
    displayName: v.optional(v.string()),
    // "ai" | "human". A human-set title is never overwritten by a later
    // rename pass; clearing the title clears this too, re-opening the door.
    displayNameSource: v.optional(v.string()),
    storageId: v.id("_storage"),
    // Hex SHA-256 of the file the user selected, computed in the browser
    // before the bytes are sent. Identity is the content, not the filename:
    // the same PDF re-downloaded under a new name is the same document, and a
    // rewritten file that kept its name is not. Absent on web clips (nothing
    // was uploaded) and on rows predating this field, so a missing hash never
    // means "unique" — see `by_project_hash` in convex/upload.ts.
    contentHash: v.optional(v.string()),
    mimeType: v.string(),
    // Size of the stored file, copied from _storage at upload. The pipeline
    // needs it to pick an Interfaze transport (convex/interfazeLimits.ts), and
    // an action cannot read the _storage system table itself. Absent on web
    // clips and on rows predating the field; a missing size reads as "small",
    // which is true of every row written under the old 18 MB upload gate.
    sizeBytes: v.optional(v.number()),
    // Objective media type, detected at upload: "pdf" | "csv" | "image" | "audio" | "video" | "webScrape"
    mediaType: v.optional(v.string()),
    // Semantic kinds ("legal brief", "tax form", ...) — a document can be
    // several at once (a signed exhibit that is also a tax form).
    kinds: v.optional(v.array(v.string())),
    // The first of `kinds`, kept in sync on every write. Everything that
    // needs a single kind (extraction template, pipeline progress) reads this,
    // so widening to an array didn't have to touch any of it.
    primaryKind: v.optional(v.string()),
    kindSource: v.optional(v.string()), // "ai" | "human"
    // Analyze's one-word bucket, for the dark pill in the library:
    // "legal" | "government" | "business" | "published" | "other". The light
    // pill beside it is `primaryKind`, the specific type. See
    // PRIMARY_CATEGORIES in convex/analyzePrompt.ts.
    primaryCategory: v.optional(v.string()),
    // When the document says it was made — not when it was uploaded. An ISO
    // prefix whose shape matches `documentDatePrecision`: "2026-08-08",
    // "2026-08", or "2026". Absent means Analyze could not date the document
    // from its own text, which the library renders as "Unknown". Never
    // inferred from content; see the dating rule in convex/analyzePrompt.ts.
    documentDate: v.optional(v.string()),
    documentDatePrecision: v.optional(v.string()), // "day" | "month" | "year"
    // Where the document situates itself — written, issued, filed, or about.
    // As the document names it ("Geneva, Switzerland"), not resolved to an
    // entity or coordinates: this is the free "where" that rides along on the
    // Analyze response, and the same bargain as documentDate applies — absent
    // means the document never placed itself, and guessing is not wanted.
    documentPlace: v.optional(v.string()),
    // The quote the place was read from. Present for the same reason
    // document_date.evidence is: it makes guessing feel expensive.
    documentPlaceEvidence: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    // Bibliographic facts Analyze read off the document, for formatting a
    // reference to it (src/lib/citation/). A real object rather than a JSON
    // string like `metadata` because the UI renders and edits single fields.
    //
    // Every field is optional and absent means the document never stated it —
    // never "not extracted yet". Absent for documents analyzed before this
    // existed, and re-analyzing is what fills them; nothing is backfilled,
    // because a backfill here is an Interfaze call per document.
    //
    // Deliberately holds nothing already known elsewhere: the date comes from
    // documentDate, the URL and access date from sourceUrl/uploadedAt, and the
    // title from displayName. Those are merged in when a citation is rendered.
    citation: v.optional(
      v.object({
        type: v.optional(v.string()),
        contributors: v.optional(
          v.array(
            v.object({
              role: v.string(), // "author" | "editor" | "translator"
              family: v.optional(v.string()),
              given: v.optional(v.string()),
              literal: v.optional(v.string()),
            })
          )
        ),
        containerTitle: v.optional(v.string()),
        publisher: v.optional(v.string()),
        publisherPlace: v.optional(v.string()),
        volume: v.optional(v.string()),
        issue: v.optional(v.string()),
        pages: v.optional(v.string()),
        edition: v.optional(v.string()),
        number: v.optional(v.string()),
        authority: v.optional(v.string()),
        jurisdiction: v.optional(v.string()),
        genre: v.optional(v.string()),
        doi: v.optional(v.string()),
        isbn: v.optional(v.string()),
        url: v.optional(v.string()),
      })
    ),
    // Detailed metadata extractor output (JSON string), human-editable
    metadata: v.optional(v.string()),
    // Nested table of contents from the Analyze pass. Stored flat with a
    // depth so the tree is representable without a recursive validator;
    // `level` is 1-based and monotonic-ish, `page` is 1-based to match what
    // the viewer navigates by. Absent = Analyze hasn't run (or found no
    // structure), in which case the Contents tab falls back to SectionHeader
    // blocks from the scan.
    // Broad-to-specific type paths from Analyze (["legal document",
    // "writ of mandate"]). `kinds`/`primaryKind` stay the flat handle every
    // existing consumer reads; this is the hierarchy behind them.
     // Analyze's guess at where this file contains more than one document.
    // Suggestions only — splitting is a user action and would need provenance
    // (a parent document id on the pieces), which does not exist yet.
    tableOfContents: v.optional(
      v.array(
        v.object({
          title: v.string(),
          level: v.number(),
          page: v.number(),
        })
      )
    ),
    pageCount: v.optional(v.number()),
    status: v.string(), // "uploaded" | "parsing" | "parsed" | "extracting" | "completed" | "failed"
    errorMessage: v.optional(v.string()),
    // Machine-readable failure cause, so the UI can render a specific state
    // instead of dumping a provider error string. See convex/interfaze.ts
    // FailureCode — currently "insufficient_credits" | "invalid_api_key" |
    // "rate_limited" | "timeout". Absent = uncategorized failure.
    errorCode: v.optional(v.string()),
    // Deprecated. The extraction review queue is gone — Analyze's suggestions
    // now run on their own and the user adds more from the document page — so
    // nothing writes or reads this. Kept only because rows in the wild still
    // carry it and the schema has to keep validating them.
    reviewSkippedAt: v.optional(v.number()),
    uploadedAt: v.number(),
    completedAt: v.optional(v.number()),
    // Debounce for page-image rendering (pageImages.ensureRendered)
    renderScheduledAt: v.optional(v.number()),
    // Page-derivative lifecycle is deliberately separate from document AI
    // processing. A document can be parsed while its viewer derivatives are
    // still rendering (or vice versa).
    renderStatus: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("rendering"),
        v.literal("complete"),
        v.literal("failed")
      )
    ),
    renderExpectedPages: v.optional(v.number()),
    renderedPageCount: v.optional(v.number()),
    rendererVersion: v.optional(v.number()),
    renderLastError: v.optional(v.string()),
    renderAttempts: v.optional(v.number()),
    renderStartedAt: v.optional(v.number()),
    renderCompletedAt: v.optional(v.number()),
    // Clockwise presentation rotation applied to every page. Per-page
    // adjustments are additive (pages.viewerRotationAdjustment).
    viewerRotation: v.optional(
      v.union(v.literal(0), v.literal(90), v.literal(180), v.literal(270))
    ),
    userId: v.optional(v.string()),
    // Web clips: original page URL and a plain-markdown article file that AI
    // calls use instead of the (large, data-URI-inlined) archive in storageId
    sourceUrl: v.optional(v.string()),
    textStorageId: v.optional(v.id("_storage")),
    // Translation is a derived presentation/search layer. Source OCR and
    // transcript text remain canonical and are never overwritten.
    sourceLanguageCode: v.optional(v.string()),
    sourceLanguageIsMixed: v.optional(v.boolean()),
    translationLanguageCode: v.optional(v.string()),
    translationStatus: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("translating"),
        v.literal("complete"),
        v.literal("not_needed"),
        v.literal("failed")
      )
    ),
    translationError: v.optional(v.string()),
    translationVersion: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_uploadedAt", ["uploadedAt"])
    .index("by_project", ["projectId", "uploadedAt"])
    // Exact, bounded lookups for "is this category in use" and the settings
    // per-category breakdown — an unindexed field would force a full scan.
    // Both questions are per-project now that the taxonomy is, so the global
    // index is gone: it would be a write cost on every insert for a question
    // nothing asks.
    .index("by_project_and_category", ["projectId", "primaryCategory"])
    // Duplicate detection, both pre-upload from the browser and as the
    // backstop inside createDocument. Exact-equality lookups, so they have to
    // be indexes: filtering `by_project` would read the whole project on
    // every dropped file.
    .index("by_project_hash", ["projectId", "contentHash"])
    .index("by_project_name", ["projectId", "name"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["projectId"],
    })
    // The two names are searched separately because they are different things:
    // `name` is the upload filename, `displayName` is the title the rename pass
    // wrote and the UI actually shows. A search index takes one field, and the
    // title is the one people type, so it gets its own and leads the results.
    .searchIndex("search_displayName", {
      searchField: "displayName",
      filterFields: ["projectId"],
    }),

  // The enforced primary-category taxonomy ("legal" | "government" | ...),
  // user-managed from project settings and seeded from the project's template.
  // `documents.primaryCategory` stores `key`. "other" is a reserved sentinel
  // for an off-taxonomy AI answer — it is never a row here, and never gets a
  // pill. See convex/analyzePrompt.ts.
  documentCategories: defineTable({
    // A category is a statement about what this project sorts documents into —
    // a legal project and a biology project have no reason to share one.
    projectId: v.id("projects"),
    key: v.string(),
    label: v.string(),
    // The classification-rule clause for this bucket, folded into the
    // Analyze/Metadata prompts so the enum and its instructions can't drift.
    description: v.string(),
    // Key into the fixed Tailwind color palette in
    // src/components/documents/docTypeCategories.ts.
    color: v.string(),
    // Display order, and the tie-break precedence when more than one
    // category's description plausibly fits the same document.
    order: v.number(),
    createdAt: v.number(),
  })
    // No global key index: with two projects both holding "legal", a lookup by
    // key alone asks a question that no longer has an answer.
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "key"]),

  // Semantic document kinds. Grows organically: the AI proposes new kinds,
  // humans own them, and Analyze is shown the existing list so it reuses a
  // name rather than inventing a synonym. These used to carry a default
  // extraction template (templateRoles); roles now come per document from the
  // graph pass, which is strictly better — two reports can involve entirely
  // different people.
  documentKinds: defineTable({
    // Scoping this is what stops a biology project being shown "writ of
    // mandate" as a kind worth reusing — the reuse clause exists to prevent
    // synonym invention, and a vocabulary from someone else's corpus feeds it.
    projectId: v.id("projects"),
    name: v.string(),
    source: v.string(), // "ai" | "human"
  }).index("by_project_and_name", ["projectId", "name"]),

  // Contextual roles an entity plays in a specific document
  // (Eli Cohen: "witness" in doc A, "author" in doc B)
  entityRoles: defineTable({
    entityId: v.id("entities"),
    documentId: v.id("documents"),
    role: v.string(),
    confidence: v.number(),
    source: v.string(), // "ai" | "human"
  })
    .index("by_entity", ["entityId"])
    .index("by_document", ["documentId"])
    .index("by_entity_and_document", ["entityId", "documentId"]),

  // Entity types a project cares about beyond person and organization.
  //
  // The base two are universal and live in code (convex/relationshipsNode.ts).
  // These are per-project additions — "vessels", "bank accounts" — declared by
  // the user and folded into the extraction schema's type enum at call time,
  // the same way primary_category's enum is built from live documentCategories.
  // Declaring one changes what NEW documents extract; nothing is backfilled.
  projectEntityTypes: defineTable({
    projectId: v.id("projects"),
    /** Lowercase slug. This is the value stored in entities.types[]. */
    key: v.string(),
    /** What the group is called in the sidebar. */
    label: v.string(),
    /** Told to the model verbatim, so it reads as a definition. */
    description: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "key"]),

  // Fuzzy entity-match suggestions awaiting human confirmation.
  // Accepting merges `sourceEntityId` into `targetEntityId` and teaches an alias;
  // rejecting remembers the pair so it is never re-suggested.
  mergeSuggestions: defineTable({
    sourceEntityId: v.id("entities"), // newer / smaller entity to fold in
    targetEntityId: v.id("entities"), // existing entity to keep
    documentId: v.optional(v.id("documents")), // where the candidate surfaced
    reason: v.string(), // human-readable evidence for the match
    status: v.string(), // "pending" | "accepted" | "rejected"
  })
    .index("by_status", ["status"])
    .index("by_source_and_target", ["sourceEntityId", "targetEntityId"])
    .index("by_target", ["targetEntityId"])
    .index("by_document", ["documentId"]),

  // One row per page — the page's plain text from Interfaze OCR.
  pages: defineTable({
    documentId: v.id("documents"),
    // Denormalized from the document, like annotations.projectId. Search and
    // vector indexes filter on equality only, so scoping a search to a project
    // is impossible without the project on the row itself: the alternative is
    // to over-fetch a global top-K and drop the out-of-project rows after,
    // which silently starves a project whose hits lose the global ranking.
    // Optional only until the backfill lands — see pages.backfillProjectId.
    projectId: v.optional(v.id("projects")),
    pageNumber: v.number(),
    text: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    // Per-page source selection. Native PDF geometry wins when available;
    // Interfaze OCR remains canonical for scans without an embedded layer.
    textSource: v.optional(v.union(v.literal("pdf"), v.literal("ocr"))),
    // Whether PDF operators paint native text or only use it as an invisible
    // OCR layer. Hidden/low-quality native geometry yields to vision OCR once
    // it is available, independent of renderer/analysis completion order.
    nativeTextVisibility: v.optional(
      v.union(
        v.literal("visible"),
        v.literal("hidden"),
        v.literal("mixed"),
        v.literal("none")
      )
    ),
    nativeGeometryScore: v.optional(v.number()),
    geometryVersion: v.optional(v.number()),
    viewerRotationAdjustment: v.optional(
      v.union(v.literal(0), v.literal(90), v.literal(180), v.literal(270))
    ),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_document", ["documentId", "pageNumber"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["documentId", "projectId"],
    })
    // Semantic search over page text. Embeddings are generated after
    // parse/transcribe when GEMINI_API_KEY is set (Gemini Embedding 2 @ 1536);
    // pages without embeddings simply don't participate in the vector leg.
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["documentId", "projectId"],
    }),

  // One current-or-cached translation per page and target language. Rows are
  // written incrementally so a very large page can resume across actions.
  pageTranslations: defineTable({
    documentId: v.id("documents"),
    // Denormalized alongside pages.projectId — the translated-text search leg
    // needs the same project filter as the original-text one.
    projectId: v.optional(v.id("projects")),
    pageId: v.id("pages"),
    pageNumber: v.number(),
    sourceLanguageCode: v.string(),
    targetLanguageCode: v.string(),
    text: v.string(),
    sourceFingerprint: v.string(),
    status: v.union(v.literal("translating"), v.literal("complete")),
    nextOffset: v.number(),
    translationVersion: v.number(),
    updatedAt: v.number(),
  })
    .index("by_document", ["documentId"])
    .index("by_document_and_target_and_page", [
      "documentId",
      "targetLanguageCode",
      "pageNumber",
    ])
    .index("by_page_and_target", ["pageId", "targetLanguageCode"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["targetLanguageCode", "status", "projectId"],
    }),

  blocks: defineTable({
    documentId: v.id("documents"),
    pageId: v.id("pages"),
    pageNumber: v.number(),
    blockId: v.string(), // stable block ID for citation tracking
    blockType: v.string(), // "Line" | "Text" | "Table" | etc.
    text: v.string(),
    source: v.optional(v.union(v.literal("pdf"), v.literal("ocr"))),
    html: v.optional(v.string()),
    // Bounding box (page pixel coords, same space as pages.width/height)
    bbox: v.optional(
      v.object({
        x: v.number(),
        y: v.number(),
        width: v.number(),
        height: v.number(),
      })
    ),
    // Line-level OCR confidence (0-1)
    confidence: v.optional(v.number()),
    // Word-level OCR detail: per-word boxes + confidence, for tight
    // sub-line highlights and confidence-aware mentions
    words: v.optional(
      v.array(
        v.object({
          text: v.string(),
          bbox: v.optional(
            v.object({
              x: v.number(),
              y: v.number(),
              width: v.number(),
              height: v.number(),
            })
          ),
          confidence: v.optional(v.number()),
        })
      )
    ),
  })
    .index("by_page", ["pageId"])
    .index("by_document", ["documentId", "pageNumber"]),

  // Human markup on a page: a colored highlight over a run of selected text,
  // optionally carrying a comment.
  //
  // The anchor is geometry, not DOM state. `rects` are in the page's own
  // coordinate space — the same space as pages.width/height and blocks.bbox —
  // so a highlight survives zoom, rotation, and re-rendering the same way the
  // OCR overlays do, and does not depend on the text layer producing an
  // identical set of spans twice. `blockIds` records which OCR blocks the
  // selection crossed, so a later pass can re-anchor or cite without having to
  // re-derive it from pixels.
  //
  // `sectionTitle` is denormalized at creation time on purpose: it is what the
  // user saw the highlight sitting under, and re-deriving it later against a
  // re-analyzed outline would silently retitle old notes.
  annotations: defineTable({
    documentId: v.id("documents"),
    // Denormalized from the document so project-wide note views don't have to
    // load every document row to filter.
    projectId: v.optional(v.id("projects")),
    pageNumber: v.number(), // 0-indexed, matching pages/blocks
    color: v.union(
      v.literal("yellow"),
      v.literal("green"),
      v.literal("blue"),
      v.literal("pink"),
      v.literal("purple")
    ),
    // The selected text itself, so the notes list reads without loading pages.
    text: v.string(),
    // Absent = a bare highlight. Empty string is never stored.
    comment: v.optional(v.string()),
    sectionTitle: v.optional(v.string()),
    rects: v.array(
      v.object({
        x: v.number(),
        y: v.number(),
        width: v.number(),
        height: v.number(),
      })
    ),
    blockIds: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_document", ["documentId", "pageNumber"]),

  // Visual evidence detected on document pages (signatures, redactions,
  // stamps, handwriting, photographs, logos). Bboxes are model-estimated
  // and normalized 0-1 (origin top-left) — approximate page regions, not
  // OCR-precise coordinates.
  detections: defineTable({
    documentId: v.id("documents"),
    pageNumber: v.number(), // 0-indexed
    label: v.string(), // "signature" | "redaction" | "stamp_or_seal" | ...
    description: v.string(),
    confidence: v.number(),
    bbox: v.optional(
      v.object({
        x: v.number(),
        y: v.number(),
        width: v.number(),
        height: v.number(),
      })
    ),
  }).index("by_document", ["documentId", "pageNumber"]),

  // Diarized transcript segments for audio/video documents, with word-level
  // timestamps (seconds) for click-to-seek playback
  transcriptSegments: defineTable({
    documentId: v.id("documents"),
    segmentIndex: v.number(),
    speaker: v.string(), // diarized label, e.g. "Speaker 1"
    startTime: v.number(),
    endTime: v.number(),
    text: v.string(),
    translatedText: v.optional(v.string()),
    translatedLanguageCode: v.optional(v.string()),
    translationVersion: v.optional(v.number()),
    words: v.array(
      v.object({
        word: v.string(),
        start: v.number(),
        end: v.number(),
      })
    ),
  }).index("by_document", ["documentId", "segmentIndex"]),

  // App-wide preferences. `global` is the only current key; keeping it
  // explicit makes the singleton index-safe and leaves room for future scopes.
  // What each account has spent, and what it is allowed to spend.
  //
  // Separate from `apiUsageTotals` rather than a dimension on it. That table is
  // sharded eight ways and read with a hardcoded `.take(TOTALS_SHARDS + 1)`
  // (convex/apiLogs.ts), so adding an account dimension there would grow it to
  // accounts × 8 and make lifetime spend silently under-report. This table is
  // one row per account and is read by user id.
  //
  // Unsharded, unlike the deployment totals, because the contention that forced
  // sharding there is a *deployment-wide* fan-out — twenty parallel chunk
  // parses all incrementing one row. Here those writes are already split
  // across accounts, and one account's own concurrency is bounded by the
  // deployment's scheduled-function limit. If a single account ever fans out
  // wide enough to conflict with
  // itself, this shards the same way that one did.
  userUsage: defineTable({
    userId: v.string(),
    // Cumulative, never reset. `apiLogs` detail is pruned after 30 days
    // (convex/crons.ts), so a spend cap cannot be computed from it — this is
    // the ledger, the same way apiUsageTotals is for the deployment.
    spentUsd: v.number(),
    // What this account may spend before work stops. Per-account rather than a
    // constant so raising someone's ceiling is a row edit, not a deploy — that
    // is the whole mechanism behind "reach out and I'll grant you more".
    // Absent means the default in convex/budget.ts.
    limitUsd: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // An anonymous try-it-out session on the landing page.
  //
  // The row *is* the identity. `demo:<token>` is written into
  // `projects.ownerId`, so every ownership walk in convex/ownership.ts, the
  // `userUsage` ledger and the spend cap all apply to a demo visitor without
  // knowing one exists — the only thing convex/demo.ts adds is a way to arrive
  // at that owner id without a Better Auth session.
  //
  // `token` is a bearer secret and the only credential: whoever holds it is
  // this session. That is acceptable because it reaches nothing but the one
  // document the same holder uploaded, and the `demo:` prefix cannot collide
  // with a Better Auth id (those carry no colon), so a crafted token can never
  // name a real account's project.
  //
  // `documentId` is what makes "one file" enforceable on the server rather
  // than in the browser: the second createDocument on a session that already
  // has one is refused, whatever the client believes.
  demoSessions: defineTable({
    token: v.string(),
    projectId: v.id("projects"),
    documentId: v.optional(v.id("documents")),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    // Both the daily issuance cap and the expiry sweep read this range.
    .index("by_createdAt", ["createdAt"]),

  // Per-user preferences. One row per account, created on first write.
  //
  // This was `appSettings`, a single `key: "global"` row — so one user
  // changing their reading language changed everyone's, and re-queued a
  // translation for every document in the deployment. Both are the same bug:
  // a deployment-wide singleton standing in for a per-user fact.
  //
  // `userId` is a Better Auth id, `v.string()` and never `v.id("users")`, for
  // the reason in docs/auth-plan.md §7.1. Nothing here walks to a project,
  // because a preference belongs to the person rather than to their work; the
  // pipeline walks *to* this from a document (settings.languageForDocument).
  //
  // An absent row means the defaults, so a new account needs no backfill.
  userSettings: defineTable({
    userId: v.string(),
    defaultLanguageCode: v.string(),
    // Bumped on every language change. Translation work carries the version it
    // was queued under and is dropped when it no longer matches, so switching
    // language twice quickly cannot leave the first language's results behind.
    translationVersion: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // Structured extraction results from Interfaze structured-output extraction

  // Deduplicated entities (people, organizations, custom types).
  // Entities are per-project: the same real-world person in two projects is
  // two rows, each with its own mentions/merges/relationships.
  entities: defineTable({
    projectId: v.optional(v.id("projects")),
    name: v.string(),
    type: v.string(), // legacy single type; kept in sync with types[0]
    // Stable global types: "person" | "organization" | "place" | "other".
    // Contextual roles (witness, author, ...) live in entityRoles instead.
    types: v.optional(v.array(v.string())),
    mentionCount: v.number(),
    documentCount: v.number(),
    avgConfidence: v.number(),
    aliases: v.array(v.string()),
    isCustom: v.boolean(),
    // User-curated entities stay visible beneath a closed type group.
    starred: v.optional(v.boolean()),
    // `slugify(name)`, stored so `/entity/:slug` is an index lookup rather
    // than a scan over search hits. Optional only because rows written before
    // this field existed carry no slug until the backfill runs; an entity's
    // name never changes after creation (a merge deletes the loser rather than
    // renaming the winner), so the value is stable once written.
    slug: v.optional(v.string()),
  })
    .index("by_type", ["type", "mentionCount"])
    .index("by_name", ["name"])
    .index("by_project", ["projectId"])
    // projectId second: the same real-world name is a separate row per project,
    // so the slug alone is ambiguous and every in-app link scopes it.
    .index("by_slug_and_project", ["slug", "projectId"])
    // The library sorts entities by mentionCount, so the 200-row cap has to
    // cut the tail rather than an arbitrary creation-order slice — otherwise
    // the most-mentioned entities can never reach the client.
    .index("by_project_and_mentions", ["projectId", "mentionCount"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["type", "projectId"],
    }),

  // Entity occurrences in documents
  mentions: defineTable({
    entityId: v.id("entities"),
    documentId: v.id("documents"),
    pageId: v.id("pages"),
    pageNumber: v.number(),
    text: v.string(),
    confidence: v.number(),
    bbox: v.optional(
      v.object({
        x: v.number(),
        y: v.number(),
        width: v.number(),
        height: v.number(),
      })
    ),
    blockId: v.optional(v.string()), // OCR block id for citation
  })
    .index("by_entity", ["entityId", "documentId"])
    .index("by_document", ["documentId", "pageNumber"]),

  // Per-document per-stage processing progress ("parse" | "metadata" |
  // "extract" | "relationships" | "transcribe")
  processingJobs: defineTable({
    documentId: v.id("documents"),
    stage: v.string(),
    status: v.string(), // "pending" | "running" | "completed" | "failed"
    // Queue metadata is optional for rows created before it existed. workId
    // is the scheduled-function id ("enqueuing" until the enqueue records it;
    // rows from the workpool era carry ids the scheduler cannot parse).
    queuedAt: v.optional(v.number()),
    workId: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_document", ["documentId", "stage"])
    .index("by_status", ["status"])
    .index("by_stage_and_status", ["stage", "status"]),

  // Operator controls for the shared Interfaze pipeline. Every stage action
  // checks the pause flag as it starts (processing.bailIfPaused).
  processingControl: defineTable({
    key: v.string(),
    paused: v.boolean(),
    // Why the queue is paused. "provider_blocked" means the pipeline paused
    // itself because the provider rejected every call (no credits, bad key);
    // absent means a human pressed pause. The distinction matters on retry:
    // the automatic pause is cleared for the user, a deliberate one is not.
    pausedReason: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),


  // One row per external AI provider: is it actually usable right now?
  //
  // These failures degrade SILENTLY by design — when Gemini's quota is gone
  // the semantic leg of search is skipped and results quietly fall back to
  // keyword + entity matching. That is the right runtime behavior and the
  // wrong thing to hide, so every embedding call reports its outcome here
  // and the settings page turns it into an unmissable banner.
  providerHealth: defineTable({
    provider: v.string(), // "google" | "interfaze"
    // "ok" | "quota_exhausted" | "auth_failed" | "error" | "not_configured"
    status: v.string(),
    message: v.optional(v.string()),
    lastOkAt: v.optional(v.number()),
    lastErrorAt: v.optional(v.number()),
    // Consecutive failures since the last success; 0 while healthy
    consecutiveFailures: v.number(),
    updatedAt: v.number(),
  }).index("by_provider", ["provider"]),

  // Deep searches: each run is a row so the action pipeline (plan →
  // retrieve → synthesize) can stream progress reactively to the client.
  searches: defineTable({
    projectId: v.optional(v.id("projects")),
    query: v.string(),
    // "planning" | "searching" | "synthesizing" | "completed" | "failed"
    status: v.string(),
    // Interfaze query plan (JSON string) — kept for transparency/debugging
    plan: v.optional(v.string()),
    // Fused, ranked retrieval hits (bounded — search.SYNTHESIS_PAGES)
    results: v.optional(
      v.array(
        v.object({
          documentId: v.id("documents"),
          documentName: v.string(),
          pageNumber: v.number(), // 0-indexed
          snippet: v.string(),
          score: v.number(),
          // Which retrieval legs surfaced this hit: "text" | "semantic" | "entity"
          sources: v.array(v.string()),
        })
      )
    ),
    // Entities the plan resolved against the graph, for chips in the UI
    matchedEntities: v.optional(
      v.array(
        v.object({
          entityId: v.id("entities"),
          name: v.string(),
          type: v.string(),
        })
      )
    ),
    answer: v.optional(v.string()), // markdown, cites sources as [n]
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_project", ["projectId", "createdAt"]),

  // Entity relationships extracted from documents
  relationships: defineTable({
    sourceEntityId: v.id("entities"),
    targetEntityId: v.id("entities"),
    relationType: v.string(), // short verb phrase, e.g. "employed_by", "met_with", "paid"
    confidence: v.number(),
    mentionId: v.optional(v.id("mentions")),
    // Provenance: which document asserted this, and the supporting quote
    documentId: v.optional(v.id("documents")),
    quote: v.optional(v.string()),
    pageNumber: v.optional(v.number()), // 0-indexed page where the quote appears
    eventDate: v.optional(v.string()), // when the relationship occurred, if stated (ISO-ish)
    // Where this particular event happened, as the quote names it. Distinct
    // from documents.documentPlace, which is where the document itself is
    // from: a London-filed report can describe a meeting in Geneva.
    place: v.optional(v.string()),
  })
    .index("by_source", ["sourceEntityId"])
    .index("by_target", ["targetEntityId"])
    .index("by_document", ["documentId"]),

  // One row per *distinct kind* of failure, not per failure.
  //
  // The sibling of apiLogs: that table exists so production traffic doubles as
  // the cost benchmark, this one so production traffic doubles as the pain-point
  // corpus. Both are written at a chokepoint every caller already passes
  // through, which is the only way a new call site cannot forget to report.
  //
  // Rows are aggregates, so unlike apiLogs there is nothing to prune — a row is
  // bounded (three samples, fifty owner ids) no matter how often it fires.
  // Nothing here is document text; see convex/issueFingerprint.ts for what is
  // stripped and why the stripping is what makes the grouping work.
  issues: defineTable({
    // fnv1a over surface|stage|errorCode|fileKind|title — see issueFingerprint.
    fingerprint: v.string(),
    // Which layer noticed: "client" (browser, before the bytes land),
    // "pipeline" (a processing stage), "render" (page derivatives),
    // "provider" (an Interfaze/embeddings call that errored), "crash"
    // (an unhandled throw or a React render error).
    surface: v.string(),
    // "preflight" | "upload" | "parse" | "analyze" | "extract" | "transcribe"
    // | "relationships" | "render" | "boundary" | "unhandled" | ...
    stage: v.string(),
    // From a closed vocabulary: a PdfPreflightResult code, an interfaze
    // FailureCode, or a JS error name. Absent = uncategorized.
    errorCode: v.optional(v.string()),
    // The normalized message. Doubles as the group key's message component, so
    // what is counted and what is read cannot disagree.
    title: v.string(),
    fileKind: v.optional(v.string()), // "pdf" | "audio" | "docx" | "csv" | ...
    count: v.number(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    firstBuildSha: v.optional(v.string()),
    lastBuildSha: v.optional(v.string()),
    // Distinct accounts hit, as a capped set rather than a counter: one user
    // failing fifty times and fifty users failing once are the same number and
    // completely different problems, and only the set can tell them apart.
    // Exact up to the cap, honest past it via ownersTruncated ("50+").
    ownerSample: v.array(v.string()),
    ownersTruncated: v.boolean(),
    // The most recent occurrences, kept for the report to quote and — via
    // documentId — to re-run. Bounded, newest first.
    samples: v.array(
      v.object({
        at: v.number(),
        raw: v.string(), // scrubbed prose, SAMPLE_CHARS
        documentId: v.optional(v.id("documents")),
        sizeBytes: v.optional(v.number()),
        pageCount: v.optional(v.number()),
        mimeType: v.optional(v.string()),
      })
    ),
    state: v.union(
      v.literal("open"),
      v.literal("triaged"),
      v.literal("resolved"),
      v.literal("ignored")
    ),
    // Set when a resolved or triaged row starts firing again — the signal that
    // turns this from a one-time cleanup into something that keeps watch.
    regressedAt: v.optional(v.number()),
    // Written back by the triage agent, never by the pipeline.
    triage: v.optional(
      v.object({
        markdown: v.string(),
        // The count at the moment of triage. Regrowth past it is what marks a
        // triaged issue worth looking at again.
        atCount: v.number(),
        at: v.number(),
        buildSha: v.optional(v.string()),
      })
    ),
  })
    .index("by_fingerprint", ["fingerprint"])
    .index("by_state_and_lastSeen", ["state", "lastSeenAt"]),

  // One row per external AI API call (Interfaze, OpenAI embeddings), with
  // token usage and estimated cost — powers the settings/usage page.
  apiLogs: defineTable({
    provider: v.string(), // "interfaze" | "openai"
    operation: v.string(), // "parse", "extract", "transcribe", ...
    model: v.string(),
    status: v.union(v.literal("ok"), v.literal("error")),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    costUsd: v.number(),
    durationMs: v.number(),
    cacheHit: v.optional(v.boolean()),
    error: v.optional(v.string()),
    documentId: v.optional(v.id("documents")),

    // Measurement fields, computed at the Interfaze chokepoint. These exist so
    // production traffic *is* the benchmark: the offline scan bench derived 24
    // of its 31 columns from data available at the call site, and cost real
    // money per run to get them. All optional — rows predate them, and the
    // embeddings caller supplies none.
    finishReason: v.optional(v.string()), // "length" = truncated, billed in full
    promptHash: v.optional(v.string()), // cohort key: prompt/schema shape only
    outputHash: v.optional(v.string()), // two uncached runs differing = nondeterminism
    errorCode: v.optional(v.string()), // classified, so errors group without parsing
    buildSha: v.optional(v.string()), // which deploy produced this row

    // The account that caused this call, resolved at write time by walking the
    // document to its project (convex/apiLogs.ts `record`). A v.string() and
    // never a v.id("users") — the user record lives in the Better Auth
    // component's tables (docs/auth-plan.md §7.1).
    //
    // Optional on the first deploy and forever, with no narrowing step: three
    // classes of row legitimately have no owner — rows written before accounts
    // existed, orphans whose document or project has since been deleted, and
    // any call site holding neither a document nor a project. They aggregate
    // into an "Unattributed" line, which is honest and is also the only way to
    // notice if resolution ever silently stops working.
    //
    // Attribution is a snapshot: documentMove can move a document to another
    // project afterwards, and historic rows keep the owner who actually paid.
    ownerId: v.optional(v.string()),
  })
    // The table had no indexes: `list` worked only by riding by_creation_time.
    // by_operation carries _creationTime as its implicit tiebreaker, so it
    // answers every "last N days of operation X" question on its own.
    .index("by_operation", ["operation"])
    .index("by_document", ["documentId"])
    .index("by_owner", ["ownerId"]),

  // Denormalized running totals (singleton) so the usage page never has to
  // scan/count the full log.
  // Denormalized running totals so the usage page never has to scan the full
  // log. Sharded: a chunked parse fans out ~20 parallel actions that all log,
  // and a single row would serialize (and OCC-thrash) every one of them.
  // Reads sum every shard; the legacy unsharded row (shard absent) still
  // counts, so no backfill is needed.
  apiUsageTotals: defineTable({
    shard: v.optional(v.number()),
    calls: v.number(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    costUsd: v.number(),
    // Optional for backwards compatibility with totals created before vcache
    // observability was added. Only successful Interfaze responses are
    // measurable because errors do not include a cache result.
    cacheMeasuredCalls: v.optional(v.number()),
    cacheHits: v.optional(v.number()),
  }).index("by_shard", ["shard"]),
});

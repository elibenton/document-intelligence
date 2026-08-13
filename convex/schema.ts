import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Top-level workspaces. Everything (documents, entities, stories, searches)
  // lives inside exactly one project; a document copied to another project is
  // a separate row with its own extraction layer.
  projects: defineTable({
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_createdAt", ["createdAt"])
    .searchIndex("search_name", { searchField: "name" }),

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
    mimeType: v.string(),
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
    // Per-document extraction suggestions from the understanding pass. These
    // must not be inferred back from a broad shared kind such as "report":
    // two reports can require entirely different entities.
    suggestedRoles: v.optional(
      v.array(
        v.object({
          role: v.string(),
          question: v.string(),
          entityType: v.string(),
        })
      )
    ),
    tags: v.optional(v.array(v.string())),
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
    documentTypes: v.optional(
      v.array(v.object({ path: v.array(v.string()), confidence: v.number() }))
    ),
    // Analyze's guess at where this file contains more than one document.
    // Suggestions only — splitting is a user action and would need provenance
    // (a parent document id on the pieces), which does not exist yet.
    suggestedSplits: v.optional(
      v.array(
        v.object({
          title: v.string(),
          startPage: v.number(),
          endPage: v.number(),
          documentType: v.string(),
          reason: v.string(),
          confidence: v.number(),
        })
      )
    ),
    // Extraction pills for the review queue: label, the editable prompt behind
    // it, and why this document warrants it.
    suggestedExtractions: v.optional(
      v.array(
        v.object({
          label: v.string(),
          prompt: v.string(),
          rationale: v.string(),
        })
      )
    ),
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
    // Set when the user dismisses the document from the extraction review
    // queue without running anything. It leaves the queue but stays flagged in
    // the library as never extracted against — skipping is allowed, silently
    // forgetting is not.
    reviewSkippedAt: v.optional(v.number()),
    // Set when the document is archived (hidden from the main list, kept
    // queryable). Cleared on restore. Absent = active.
    archivedAt: v.optional(v.number()),
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
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["projectId"],
    }),

  // Semantic document kinds with their default extraction templates.
  // Grows organically: the AI proposes new kinds, humans own them.
  documentKinds: defineTable({
    name: v.string(),
    source: v.string(), // "ai" | "human"
    // Default extraction template: what to look for and the question to ask
    templateRoles: v.array(
      v.object({
        role: v.string(), // contextual role, e.g. "witness", "filer"
        question: v.string(), // the question Interfaze asks during extraction
        entityType: v.string(), // stable type: "person" | "organization" | "place" | "other"
      })
    ),
  }).index("by_name", ["name"]),

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
    .index("by_role", ["role"])
    .index("by_entity_and_document", ["entityId", "documentId"]),

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
      filterFields: ["documentId"],
    })
    // Semantic search over page text. Embeddings are generated after
    // parse/transcribe when GEMINI_API_KEY is set (Gemini Embedding 2 @ 1536);
    // pages without embeddings simply don't participate in the vector leg.
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["documentId"],
    }),

  // One current-or-cached translation per page and target language. Rows are
  // written incrementally so a very large page can resume across actions.
  pageTranslations: defineTable({
    documentId: v.id("documents"),
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
    .index("by_page", ["pageId"])
    .index("by_document_and_target_and_page", [
      "documentId",
      "targetLanguageCode",
      "pageNumber",
    ])
    .index("by_page_and_target", ["pageId", "targetLanguageCode"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["targetLanguageCode", "status"],
    }),

  // Pre-rendered page rasters (PNG in storage), one row per PDF page.
  // The viewer shows these images instead of rendering the PDF client-side
  // with pdf.js — deterministic pixels, no canvas/text-layer flakiness.
  // Rendered server-side (renderPages.ts) after upload; width/height are the
  // raster's pixel dimensions (same aspect ratio as pages.width/height).
  pageImages: defineTable({
    documentId: v.id("documents"),
    pageNumber: v.number(), // 0-indexed, matching pages/blocks
    storageId: v.id("_storage"),
    width: v.number(),
    height: v.number(),
    rendererVersion: v.optional(v.number()),
  }).index("by_document", ["documentId", "pageNumber"]),

  // Singleton progress records for versioned page-derivative migrations.
  // Keeping the cursor server-side makes a large archive restartable without
  // asking an operator to track offsets or requeue every document.
  rendererBackfills: defineTable({
    key: v.string(),
    rendererVersion: v.number(),
    status: v.union(v.literal("running"), v.literal("complete")),
    cursor: v.optional(v.string()),
    scanned: v.number(),
    scheduled: v.number(),
    startedAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  // Block-level content from OCR (one row per text line)
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
    .index("by_document", ["documentId", "pageNumber"])
    .index("by_blockId", ["blockId"]),

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
  appSettings: defineTable({
    key: v.string(),
    defaultLanguageCode: v.string(),
    translationVersion: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Structured extraction results from Interfaze structured-output extraction
  extractions: defineTable({
    documentId: v.id("documents"),
    schemaUsed: v.string(), // JSON string of the schema that was used
    results: v.string(), // JSON string of extraction_schema_json
    citations: v.optional(v.string()), // JSON string of citation mapping
    pageRange: v.optional(v.string()), // which pages were extracted
    extractedAt: v.number(),
  }).index("by_document", ["documentId"]),

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
  })
    .index("by_type", ["type", "mentionCount"])
    .index("by_name", ["name"])
    .index("by_project", ["projectId"])
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
    // Queue metadata is optional for rows created before Workpool was added.
    queuedAt: v.optional(v.number()),
    workId: v.optional(v.string()),
    progress: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_document", ["documentId", "stage"])
    .index("by_status", ["status"])
    .index("by_status_and_queuedAt", ["status", "queuedAt"])
    .index("by_stage_and_status", ["stage", "status"]),

  // Operator controls for the shared Interfaze workpool. Kept outside the
  // component so the application UI can subscribe to pause state directly.
  processingControl: defineTable({
    key: v.string(),
    paused: v.boolean(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Web-research dossiers for an entity, produced by convex/research.ts
  research: defineTable({
    documentId: v.id("documents"),
    entityName: v.string(),
    query: v.string(),
    content: v.string(), // JSON dossier matching DOSSIER_SCHEMA
    citations: v.array(v.string()), // source URLs
    searchResults: v.optional(
      v.array(
        v.object({
          title: v.string(),
          url: v.string(),
          snippet: v.string(),
        })
      )
    ),
    model: v.string(),
    status: v.string(), // "pending" | "completed" | "failed"
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_document", ["documentId"])
    .index("by_document_entity", ["documentId", "entityName"]),

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
    // Fused, ranked retrieval hits (bounded, top ~12)
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
  })
    .index("by_source", ["sourceEntityId"])
    .index("by_target", ["targetEntityId"])
    .index("by_document", ["documentId"]),

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
  }),

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

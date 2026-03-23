import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Uploaded PDF documents
  documents: defineTable({
    name: v.string(),
    storageId: v.id("_storage"),
    mimeType: v.string(),
    pageCount: v.optional(v.number()),
    status: v.string(), // "uploaded" | "parsing" | "parsed" | "extracting" | "completed" | "failed"
    errorMessage: v.optional(v.string()),
    uploadedAt: v.number(),
    completedAt: v.optional(v.number()),
    // Datalab checkpoint ID — reuse parsed doc for extract without re-parsing
    datalabCheckpointId: v.optional(v.string()),
    userId: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_uploadedAt", ["uploadedAt"]),

  // One row per PDF page — parsed markdown text from Datalab convert
  pages: defineTable({
    documentId: v.id("documents"),
    pageNumber: v.number(),
    markdownText: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_document", ["documentId", "pageNumber"])
    .searchIndex("search_text", {
      searchField: "markdownText",
      filterFields: ["documentId"],
    }),

  // Block-level content from Datalab JSON output (text, tables, headings, images)
  blocks: defineTable({
    documentId: v.id("documents"),
    pageId: v.id("pages"),
    pageNumber: v.number(),
    blockId: v.string(), // Datalab block ID for citation tracking
    blockType: v.string(), // "Text" | "Table" | "SectionHeader" | "ListItem" | "Picture" | etc.
    text: v.string(),
    html: v.optional(v.string()),
    // Bounding box from Datalab (absolute pixel coords from the PDF)
    bbox: v.optional(
      v.object({
        x: v.number(),
        y: v.number(),
        width: v.number(),
        height: v.number(),
      })
    ),
  })
    .index("by_page", ["pageId"])
    .index("by_document", ["documentId", "pageNumber"])
    .index("by_blockId", ["blockId"]),

  // Structured extraction results from Datalab extract API
  extractions: defineTable({
    documentId: v.id("documents"),
    schemaUsed: v.string(), // JSON string of the schema that was used
    results: v.string(), // JSON string of extraction_schema_json
    citations: v.optional(v.string()), // JSON string of citation mapping
    pageRange: v.optional(v.string()), // which pages were extracted
    extractedAt: v.number(),
  }).index("by_document", ["documentId"]),

  // Deduplicated entities (people, organizations, custom types)
  entities: defineTable({
    name: v.string(),
    type: v.string(),
    mentionCount: v.number(),
    documentCount: v.number(),
    avgConfidence: v.number(),
    aliases: v.array(v.string()),
    isCustom: v.boolean(),
  })
    .index("by_type", ["type", "mentionCount"])
    .index("by_name", ["name"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["type"],
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
    blockId: v.optional(v.string()), // Datalab block ID for citation
  })
    .index("by_entity", ["entityId", "documentId"])
    .index("by_document", ["documentId", "pageNumber"]),

  // Per-document per-stage processing progress
  processingJobs: defineTable({
    documentId: v.id("documents"),
    stage: v.string(), // "parse" | "extract"
    status: v.string(), // "pending" | "running" | "completed" | "failed"
    progress: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    // Datalab request ID for polling
    datalabRequestId: v.optional(v.string()),
  }).index("by_document", ["documentId", "stage"]),

  // On-demand custom extraction requests
  customExtractionRequests: defineTable({
    schema: v.string(), // JSON schema for extraction
    status: v.string(), // "pending" | "running" | "completed" | "failed"
    documentIds: v.optional(v.array(v.id("documents"))),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    userId: v.optional(v.string()),
  }).index("by_status", ["status"]),

  // Research dossiers from Perplexity Sonar
  research: defineTable({
    documentId: v.id("documents"),
    entityName: v.string(),
    query: v.string(),
    content: v.string(), // Markdown response from Sonar
    citations: v.array(v.string()), // Array of source URLs
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

  // Stories — collections of documents
  stories: defineTable({
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    starred: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_starred", ["starred", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_slug", ["slug"]),

  // Many-to-many join: stories ↔ documents
  storyDocuments: defineTable({
    storyId: v.id("stories"),
    documentId: v.id("documents"),
    addedAt: v.number(),
  })
    .index("by_story", ["storyId"])
    .index("by_document", ["documentId"]),

  // Entity relationships
  relationships: defineTable({
    sourceEntityId: v.id("entities"),
    targetEntityId: v.id("entities"),
    relationType: v.string(),
    confidence: v.number(),
    mentionId: v.optional(v.id("mentions")),
  })
    .index("by_source", ["sourceEntityId"])
    .index("by_target", ["targetEntityId"]),
});

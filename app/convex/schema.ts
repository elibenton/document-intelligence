import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Uploaded PDF documents
  documents: defineTable({
    name: v.string(),
    storageId: v.id("_storage"),
    mimeType: v.string(),
    pageCount: v.optional(v.number()),
    status: v.string(), // "uploaded" | "ocr_processing" | "ner_processing" | "completed" | "failed"
    errorMessage: v.optional(v.string()),
    uploadedAt: v.number(),
    completedAt: v.optional(v.number()),
    // Future: auth/teams
    userId: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_uploadedAt", ["uploadedAt"]),

  // One row per PDF page — OCR extracted text
  pages: defineTable({
    documentId: v.id("documents"),
    pageNumber: v.number(),
    markdownText: v.string(),
    width: v.number(),
    height: v.number(),
    // Future: vector search
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_document", ["documentId", "pageNumber"])
    .searchIndex("search_text", {
      searchField: "markdownText",
      filterFields: ["documentId"],
    }),

  // OCR text blocks with bounding boxes (normalized 0-1 coords)
  textBlocks: defineTable({
    documentId: v.id("documents"),
    pageId: v.id("pages"),
    pageNumber: v.number(),
    text: v.string(),
    bbox: v.object({
      x: v.number(),
      y: v.number(),
      width: v.number(),
      height: v.number(),
    }),
    blockType: v.string(), // "text" | "table" | "heading" | etc.
    confidence: v.optional(v.number()),
  })
    .index("by_page", ["pageId"])
    .index("by_document", ["documentId", "pageNumber"]),

  // Deduplicated entities (people, organizations, custom types)
  entities: defineTable({
    name: v.string(),
    type: v.string(), // "person" | "organization" | "custom:weapons" etc.
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
    textBlockId: v.optional(v.id("textBlocks")),
  })
    .index("by_entity", ["entityId", "documentId"])
    .index("by_document", ["documentId", "pageNumber"]),

  // Per-document per-stage processing progress
  processingJobs: defineTable({
    documentId: v.id("documents"),
    stage: v.string(), // "ocr" | "ner" | "entity_resolution" | "indexing"
    status: v.string(), // "pending" | "running" | "completed" | "failed"
    progress: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  }).index("by_document", ["documentId", "stage"]),

  // On-demand custom NER requests
  customNerRequests: defineTable({
    label: v.string(),
    status: v.string(), // "pending" | "running" | "completed" | "failed"
    documentIds: v.optional(v.array(v.id("documents"))),
    threshold: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    // Future: auth/teams
    userId: v.optional(v.string()),
  }).index("by_status", ["status"]),

  // Future: entity relationships (GLiREL)
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

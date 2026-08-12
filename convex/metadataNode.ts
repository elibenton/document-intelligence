"use node";

/**
 * Node-runtime half of the metadata pass. The Interfaze SDK pulls Node built-ins
 * (via a dynamic `fs/promises` import in its file helpers), so every action that
 * calls Interfaze lives in a `"use node"` file; the queries/mutations it drives
 * (saveMetadataResult, updateDocumentMeta) stay in metadata.ts on the default
 * runtime and are reached by function reference.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { chatCompletion, fileUrlContent, inlineTextContent } from "./interfaze";
import { usageLogger } from "./apiLogs";
import type { Doc } from "./_generated/dataModel";

const METADATA_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Document title as written, or a concise descriptive title" },
    summary: { type: "string", description: "2-3 sentence summary of the document" },
    date: { type: "string", description: "Primary date of the document (ISO if possible), 'Unknown' if absent" },
    author: { type: "string", description: "Author/creator if identifiable, 'Unknown' otherwise" },
    language: { type: "string", description: "Primary language of the document" },
    source_language_code: {
      type: "string",
      description: "Primary language as a lowercase ISO 639 code",
    },
    is_multilingual: {
      type: "boolean",
      description: "True when meaningful passages use more than one language",
    },
    primary_kind: {
      type: "string",
      description:
        "The semantic kind of document, e.g. 'legal brief', 'tax form', 'meeting transcript'. Prefer one of the existing kinds listed in the prompt when it fits; only invent a new kind when none fit. Lowercase.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "3-6 short lowercase topical tags",
    },
    suggested_roles: {
      type: "array",
      description:
        "The entity roles worth extracting from a document of this kind, each with the question an extractor should ask. 3-6 roles.",
      items: {
        type: "object",
        properties: {
          role: { type: "string", description: "Contextual role, lowercase, e.g. 'witness', 'filer', 'attendee'" },
          question: { type: "string", description: "The extraction question, e.g. 'Who testified as witnesses in this document?'" },
          entity_type: { type: "string", enum: ["person", "organization", "place", "other"] },
        },
        required: ["role", "question", "entity_type"],
      },
    },
    additional: {
      type: "array",
      description: "Any other notable metadata as key/value pairs (case number, jurisdiction, tax year, meeting date, parties...)",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["key", "value"],
      },
    },
  },
  required: ["title", "summary", "date", "author", "language", "source_language_code", "is_multilingual", "primary_kind", "tags", "suggested_roles", "additional"],
};

export const runMetadataPass = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(api.documents.get, { id: args.documentId });
    if (!document) throw new Error("Document not found");
    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");

    // Web clips carry a plain-text article file whose text we inline —
    // Interfaze only reliably fetches PDF/image URLs. Other media stay
    // URL-referenced (stable URL doubles as Interfaze's cache key).
    let docPart;
    if (document.textStorageId) {
      const blob = await ctx.storage.get(document.textStorageId);
      if (!blob) throw new Error("Text file not found in storage");
      docPart = inlineTextContent(await blob.text());
    } else {
      const fileUrl = await ctx.storage.getUrl(document.storageId);
      if (!fileUrl) throw new Error("File not found in storage");
      docPart = fileUrlContent(fileUrl);
    }

    const kinds: Doc<"documentKinds">[] = await ctx.runQuery(api.kinds.list, {});
    const kindNames = kinds.map((k) => k.name);

    await ctx.runMutation(internal.processing.createJob, {
      documentId: args.documentId,
      stage: "metadata",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "metadata",
      status: "running",
    });

    try {
      const { content } = await chatCompletion(apiKey, {
        usage: {
          log: usageLogger(ctx, { documentId: args.documentId }),
          operation: "metadata",
        },
        systemPrompt:
          "You are a meticulous document metadata extractor. Be factual; use 'Unknown' when uncertain.",
        content: [
          docPart,
          {
            type: "text",
            text: `Extract detailed metadata for this document.${
              kindNames.length > 0
                ? ` Existing document kinds in this system: ${kindNames.join(", ")}. Use one of these as primary_kind if it fits; otherwise propose a new one.`
                : ""
            }`,
          },
        ],
        responseSchema: { name: "document_metadata", schema: METADATA_SCHEMA },
        maxTokens: 2048,
      });

      await ctx.runMutation(internal.metadata.saveMetadataResult, {
        documentId: args.documentId,
        raw: content,
      });
      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "metadata",
        status: "completed",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Metadata pass failed: ${msg}`);
      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "metadata",
        status: "failed",
      });
    }
  },
});

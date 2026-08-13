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
import {
  buildCategoryRule,
  buildKindReuseClause,
  TYPE_RULE,
  OTHER_CATEGORY,
} from "./analyzePrompt";
import type { Doc } from "./_generated/dataModel";

/** A function, not a static object — `primary_category`'s enum is the live
 *  `documentCategories` key set (see analyzePrompt.ts:buildDocumentUnderstandingSchema
 *  for why `primary_kind` is declared before `primary_category`). */
function buildMetadataSchema(categoryKeys: string[]) {
  return {
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
    // Declared before primary_kind so the model locates its evidence before
    // committing — see TYPE_RULE.
    kind_evidence: {
      type: "string",
      description:
        "The exact text — a caption, title block, form name, heading, or certification/signature line — where the document states its own type. Quoted verbatim. Empty string only if the document never states its own type and primary_kind had to be inferred.",
    },
    primary_kind: {
      type: "string",
      description:
        "The precise, specific name of this document type, read from kind_evidence — the exact named or numbered form, statute-named instrument, or standard document type when it has one (e.g. 'irs form 211', 'writ of mandate'). Prefer one of the existing kinds listed in the prompt when it fits; only invent a new kind when none fit, and only fall back to a generic term when nothing more specific applies. Lowercase.",
    },
    primary_category: {
      type: "string",
      enum: [...categoryKeys, OTHER_CATEGORY],
      description:
        "The single broad bucket primary_kind belongs to. See the category rule in the prompt for precedence when several fit.",
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
  required: ["title", "summary", "date", "author", "language", "source_language_code", "is_multilingual", "kind_evidence", "primary_kind", "primary_category", "tags", "suggested_roles", "additional"],
  };
}

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
    const categories: Doc<"documentCategories">[] = await ctx.runQuery(
      api.documentCategories.list,
      {}
    );
    const categoryDefs = categories.map((c) => ({
      key: c.key,
      label: c.label,
      description: c.description,
    }));

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
            text: `Extract detailed metadata for this document. ${TYPE_RULE} ${buildKindReuseClause(kindNames)} ${buildCategoryRule(categoryDefs)}`.trim(),
          },
        ],
        responseSchema: {
          name: "document_metadata",
          schema: buildMetadataSchema(categoryDefs.map((c) => c.key)),
        },
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

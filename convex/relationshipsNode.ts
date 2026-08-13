"use node";

/**
 * Relationship mapping — Node-runtime half. The Interfaze call lives here under
 * "use node" (the SDK needs the Node runtime); the mutation that resolves names
 * to entities and stores the rows (ingestRelationships) and the read query
 * (forEntity) stay in relationships.ts on the default runtime.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { chatCompletion } from "./interfaze";
import { usageLogger } from "./apiLogs";

// ---------------------------------------------------------------------------
// Extraction schema for the Interfaze structured-output call
// ---------------------------------------------------------------------------

const RELATIONSHIP_SCHEMA = {
  type: "object",
  properties: {
    relationships: {
      type: "array",
      description:
        "Relationships between named entities that are explicitly supported by the document text.",
      items: {
        type: "object",
        properties: {
          source: {
            type: "object",
            properties: {
              name: { type: "string", description: "Entity name as written" },
              type: {
                type: "string",
                enum: ["person", "organization", "place", "other"],
              },
            },
            required: ["name", "type"],
          },
          target: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: {
                type: "string",
                enum: ["person", "organization", "place", "other"],
              },
            },
            required: ["name", "type"],
          },
          relation_type: {
            type: "string",
            description:
              "Short lowercase verb phrase with underscores, e.g. met_with, employed_by, paid, represents, signed_contract_with, family_of, located_in, works_at",
          },
          quote: {
            type: "string",
            description:
              "Verbatim sentence from the document that supports this relationship",
          },
          page_number: {
            type: "integer",
            description:
              "1-based page number where the supporting quote appears; 0 if unknown",
          },
          event_date: {
            type: "string",
            description:
              "When the relationship occurred or was stated, if the text says (ISO format preferred, e.g. 2024-03-03); empty string if not stated",
          },
          confidence: {
            type: "number",
            description:
              "0-1: how directly the text supports this relationship (1 = stated outright, lower = inferred)",
          },
        },
        required: [
          "source",
          "target",
          "relation_type",
          "quote",
          "page_number",
          "event_date",
          "confidence",
        ],
      },
    },
  },
  required: ["relationships"],
};

// Map schema entity types to the app's entity `type` values
const TYPE_MAP: Record<string, string> = {
  person: "people",
  organization: "organization",
  place: "places",
  other: "other",
};

// ---------------------------------------------------------------------------
// Action: extract relationships from a parsed document
// ---------------------------------------------------------------------------

export const extract = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");

    const pages: { pageNumber: number; text: string }[] =
      await ctx.runQuery(internal.pages.textByDocument, {
        documentId: args.documentId,
      });
    if (pages.length === 0) return;

    const entities = await ctx.runQuery(api.entities.byDocument, {
      documentId: args.documentId,
    });

    await ctx.runMutation(internal.processing.createJob, {
      documentId: args.documentId,
      stage: "relationships",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "relationships",
      status: "running",
    });

    try {
      const documentText = pages
        .map((p) => `[Page ${p.pageNumber + 1}]\n${p.text}`)
        .join("\n\n");

      const knownEntities =
        entities.length > 0
          ? `Known entities already identified in this document:\n${entities
              .map((e) => `- ${e.name} (${e.type})`)
              .join("\n")}\n\n`
          : "";

      const { content } = await chatCompletion(apiKey, {
        usage: {
          log: usageLogger(ctx, { documentId: args.documentId }),
          operation: "relationships",
        },
        // Relationship mapping is inference-heavy — worth Interfaze's
        // reasoning mode (off by default for straight extraction).
        reasoning: true,
        systemPrompt:
          "You are an analyst mapping relationships between entities in documents. Only report relationships the text explicitly supports — never invent connections. Use the known entity names verbatim when they appear; add other entities (organizations, places) only when the document names them.",
        content: [
          {
            type: "text",
            text: `${knownEntities}Document text:\n\n${documentText}\n\nIdentify all relationships between named entities (people, organizations, places) in this document.`,
          },
        ],
        responseSchema: {
          name: "relationship_extraction",
          schema: RELATIONSHIP_SCHEMA,
        },
      });

      const parsed = JSON.parse(content) as {
        relationships?: Array<{
          source?: { name?: string; type?: string };
          target?: { name?: string; type?: string };
          relation_type?: string;
          quote?: string;
          page_number?: number;
          event_date?: string;
          confidence?: number;
        }>;
      };

      const relationships = (parsed.relationships ?? [])
        .filter(
          (r) =>
            r.source?.name?.trim() &&
            r.target?.name?.trim() &&
            r.relation_type?.trim() &&
            r.source.name.toLowerCase() !== r.target.name.toLowerCase()
        )
        .map((r) => ({
          sourceName: r.source!.name!.trim(),
          sourceType: TYPE_MAP[r.source!.type ?? "other"] ?? "other",
          targetName: r.target!.name!.trim(),
          targetType: TYPE_MAP[r.target!.type ?? "other"] ?? "other",
          relationType: r.relation_type!.trim(),
          quote: (r.quote ?? "").slice(0, 500),
          pageNumber:
            typeof r.page_number === "number" && r.page_number >= 1
              ? r.page_number - 1
              : undefined,
          eventDate: (r.event_date ?? "").trim() || undefined,
          confidence: Math.min(1, Math.max(0, r.confidence ?? 0.5)),
        }));

      await ctx.runMutation(internal.relationships.ingestRelationships, {
        documentId: args.documentId,
        relationships,
      });

      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "relationships",
        status: "completed",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "relationships",
        status: "failed",
      });
      console.error(`Relationship extraction failed: ${msg}`);
    }
  },
});

import {
  action,
  internalAction,
  internalMutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { chatCompletion } from "./interfaze";
import type { Doc, Id } from "./_generated/dataModel";

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
          confidence: {
            type: "number",
            description:
              "0-1: how directly the text supports this relationship (1 = stated outright, lower = inferred)",
          },
        },
        required: ["source", "target", "relation_type", "quote", "confidence"],
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

    const pages: Doc<"pages">[] = await ctx.runQuery(api.pages.byDocument, {
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
        .map((p) => `[Page ${p.pageNumber + 1}]\n${p.markdownText}`)
        .join("\n\n");

      const knownEntities =
        entities.length > 0
          ? `Known entities already identified in this document:\n${entities
              .map((e) => `- ${e.name} (${e.type})`)
              .join("\n")}\n\n`
          : "";

      const { content } = await chatCompletion(apiKey, {
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

/** Public entry point: (re)build relationships for one document. */
export const runForDocument = action({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await ctx.runAction(internal.relationships.extract, {
      documentId: args.documentId,
    });
  },
});

// ---------------------------------------------------------------------------
// Mutation: resolve names to entities and store relationship rows
// ---------------------------------------------------------------------------

export const ingestRelationships = internalMutation({
  args: {
    documentId: v.id("documents"),
    relationships: v.array(
      v.object({
        sourceName: v.string(),
        sourceType: v.string(),
        targetName: v.string(),
        targetType: v.string(),
        relationType: v.string(),
        quote: v.string(),
        confidence: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    // Re-run safety: replace this document's relationships
    const existing = await ctx.db
      .query("relationships")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const rel of existing) await ctx.db.delete(rel._id);

    if (args.relationships.length === 0) return;

    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const pageIdByNumber = new Map<number, Id<"pages">>();
    for (const page of pages) pageIdByNumber.set(page.pageNumber, page._id);

    // Resolve an entity name to an existing entity, or create one (with
    // mentions from matching blocks) if it's new to the graph.
    const resolved = new Map<string, Id<"entities">>();
    const resolveEntity = async (
      name: string,
      type: string
    ): Promise<Id<"entities">> => {
      const key = name.toLowerCase();
      const cached = resolved.get(key);
      if (cached) return cached;

      let entity = await ctx.db
        .query("entities")
        .withIndex("by_name", (q) => q.eq("name", name))
        .first();

      if (!entity) {
        const candidates = await ctx.db
          .query("entities")
          .withSearchIndex("search_name", (q) => q.search("name", name))
          .take(10);
        entity =
          candidates.find((e) => e.name.toLowerCase() === key) ?? null;
      }

      if (entity) {
        resolved.set(key, entity._id);
        return entity._id;
      }

      // New entity discovered via relationship extraction
      const matchingBlocks = blocks.filter((b) =>
        b.text.toLowerCase().includes(key)
      );
      const entityId = await ctx.db.insert("entities", {
        name,
        type,
        mentionCount: matchingBlocks.length,
        documentCount: 1,
        avgConfidence: 1.0,
        aliases: [],
        isCustom: type !== "people",
      });
      for (const block of matchingBlocks) {
        const pageId = pageIdByNumber.get(block.pageNumber);
        if (!pageId) continue;
        await ctx.db.insert("mentions", {
          entityId,
          documentId: args.documentId,
          pageId,
          pageNumber: block.pageNumber,
          text: block.text,
          confidence: 1.0,
          blockId: block.blockId,
          bbox: block.bbox,
        });
      }
      resolved.set(key, entityId);
      return entityId;
    };

    // Dedupe identical (source, target, type) triples within this batch
    const seen = new Set<string>();
    for (const rel of args.relationships) {
      const sourceId = await resolveEntity(rel.sourceName, rel.sourceType);
      const targetId = await resolveEntity(rel.targetName, rel.targetType);
      if (sourceId === targetId) continue;

      const dedupKey = `${sourceId}:${targetId}:${rel.relationType}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      await ctx.db.insert("relationships", {
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        relationType: rel.relationType,
        confidence: rel.confidence,
        documentId: args.documentId,
        quote: rel.quote || undefined,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** All relationships touching an entity, with the other endpoint hydrated. */
export const forEntity = query({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args) => {
    const asSource = await ctx.db
      .query("relationships")
      .withIndex("by_source", (q) => q.eq("sourceEntityId", args.entityId))
      .take(200);
    const asTarget = await ctx.db
      .query("relationships")
      .withIndex("by_target", (q) => q.eq("targetEntityId", args.entityId))
      .take(200);

    const rows = [
      ...asSource.map((r) => ({ rel: r, otherId: r.targetEntityId, direction: "outgoing" as const })),
      ...asTarget.map((r) => ({ rel: r, otherId: r.sourceEntityId, direction: "incoming" as const })),
    ];

    const results = [];
    for (const { rel, otherId, direction } of rows) {
      const other = await ctx.db.get(otherId);
      if (!other) continue;
      const doc = rel.documentId ? await ctx.db.get(rel.documentId) : null;
      results.push({
        _id: rel._id,
        direction,
        relationType: rel.relationType,
        confidence: rel.confidence,
        quote: rel.quote,
        otherEntity: { _id: other._id, name: other.name, type: other.type },
        document: doc ? { _id: doc._id, name: doc.name } : null,
      });
    }
    return results;
  },
});

/** Graph (nodes + edges) across all documents in a story. */
export const forStory = query({
  args: { storyId: v.id("stories") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("storyDocuments")
      .withIndex("by_story", (q) => q.eq("storyId", args.storyId))
      .collect();

    const docNames = new Map<Id<"documents">, string>();
    const edges = [];
    const nodeIds = new Set<Id<"entities">>();

    for (const link of links) {
      const doc = await ctx.db.get(link.documentId);
      if (!doc) continue;
      docNames.set(doc._id, doc.name);

      const rels = await ctx.db
        .query("relationships")
        .withIndex("by_document", (q) => q.eq("documentId", link.documentId))
        .take(500);

      for (const rel of rels) {
        nodeIds.add(rel.sourceEntityId);
        nodeIds.add(rel.targetEntityId);
        edges.push({
          _id: rel._id,
          source: rel.sourceEntityId,
          target: rel.targetEntityId,
          relationType: rel.relationType,
          confidence: rel.confidence,
          quote: rel.quote,
          documentName: docNames.get(rel.documentId!) ?? "",
        });
      }
    }

    const nodes = [];
    for (const id of nodeIds) {
      const entity = await ctx.db.get(id);
      if (!entity) continue;
      nodes.push({
        _id: entity._id,
        name: entity.name,
        type: entity.type,
        mentionCount: entity.mentionCount,
      });
    }

    return { nodes, edges };
  },
});

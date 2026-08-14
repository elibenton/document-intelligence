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
import { chatCompletion, failureCodeOf } from "./interfaze";
import { usageLogger } from "./apiLogs";

// ---------------------------------------------------------------------------
// Extraction schema for the Interfaze structured-output call
// ---------------------------------------------------------------------------

/** The two types every project has. Anything else is project-declared. */
export const BASE_ENTITY_TYPES = ["person", "organization"];

/**
 * One pass: who is in this document, and how they connect.
 *
 * `entities` is declared before `relationships` and is authoritative. The
 * relationship items reference entities by name only — carrying a type on each
 * endpoint as well would let the same name be typed two ways in one response,
 * and there would be no principled way to pick a winner. Endpoints that never
 * appear in `entities` are dropped at ingest rather than guessed at.
 *
 * Within a relationship the order is a reasoning chain: the endpoints, then
 * what connects them, then the evidence, then the facts read off that evidence
 * (when, where), then confidence last — so the score is formed with every other
 * field already in context.
 */
export function buildGraphSchema(extraTypes: string[]) {
  // Sorted and deduped: this enum is part of the prompt, and the prompt is the
  // Interfaze cache key. Project categories arrive in table order, so two
  // documents in the same project could otherwise produce two different
  // prompts and lose a free cache hit. Order carries no meaning to the model.
  const entityTypes = [
    ...BASE_ENTITY_TYPES,
    ...[...new Set(extraTypes)].sort(),
  ];

  return {
    type: "object",
    properties: {
      entities: {
        type: "array",
        description:
          "Every named entity of the listed types that this document names. Complete: any name used in relationships must appear here.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Entity name as written in the document",
            },
            type: { type: "string", enum: entityTypes },
            role: {
              type: "string",
              description:
                "What this entity does in THIS document — witness, author, signatory, buyer, defendant, employer. Lowercase, one or two words. Empty string when the document gives it no particular role.",
            },
          },
          required: ["name", "type", "role"],
        },
      },
      relationships: {
        type: "array",
        description:
          "Relationships between the entities above that are explicitly supported by the document text.",
        items: {
          type: "object",
          properties: {
            source_name: {
              type: "string",
              description: "Name of the acting entity, exactly as listed in entities",
            },
            target_name: {
              type: "string",
              description: "Name of the entity acted upon, exactly as listed in entities",
            },
            relation_type: {
              type: "string",
              description:
                "Short lowercase verb phrase with underscores, e.g. met_with, employed_by, paid, represents, signed_contract_with, family_of, works_at",
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
                "When the relationship occurred, if the quote says (ISO format preferred, e.g. 2024-03-03); empty string if not stated",
            },
            place: {
              type: "string",
              description:
                "Where this particular event happened, if the quote names a location. Empty string if not stated — do not fall back to where the document itself was written.",
            },
            confidence: {
              type: "number",
              description:
                "0-1: how directly the text supports this relationship (1 = stated outright, lower = inferred)",
            },
          },
          required: [
            "source_name",
            "target_name",
            "relation_type",
            "quote",
            "page_number",
            "event_date",
            "place",
            "confidence",
          ],
        },
      },
    },
    required: ["entities", "relationships"],
  };
}

/**
 * What counts as an organization, and what counts as neither.
 *
 * "Any named collective" is deliberately broad — a review committee and a
 * family are both groups acting together, and a reader looking for who was
 * involved wants them. The exclusions are the ones that made the old extraction
 * path unusable: it typed dates, clauses and addresses as entities because its
 * vocabulary came from whatever JSON key produced them.
 */
function entityRule(extra: { key: string; label: string; description: string }[]) {
  const base =
    "A person is a named individual human. An organization is any named collective acting as a group: companies, agencies, courts, committees, partnerships, unions, families, boards. ";

  // Project types are defined before the exclusion, not after it: a rule saying
  // "nothing else is an entity" read last would override the definitions that
  // came before it. Sorted so the prompt is byte-identical between documents
  // in the same project, which is what keeps the Interfaze cache warm.
  const declared = [...extra]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((t) => `A ${t.label.toLowerCase()} (type "${t.key}") is ${t.description} `)
    .join("");

  return (
    base +
    declared +
    "Nothing else is an entity. Do not list dates, monetary amounts, addresses, document titles, contract clauses, case numbers, or objects — no matter how important they are to the document. " +
    "Use the fullest form of each name the document gives, and list each entity once."
  );
}

/** Map schema entity types to the app's legacy `type` values. */
const TYPE_MAP: Record<string, string> = {
  person: "people",
  organization: "organization",
};

// ---------------------------------------------------------------------------
// Action: extract relationships from a parsed document
// ---------------------------------------------------------------------------

export const extract = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");

    // The job row is created by processing.runRelationships, which enqueues
    // this action through the pool so a 10-minute kill still lands somewhere.
    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "extracting",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "relationships",
      status: "running",
    });

    const pages: { pageNumber: number; text: string }[] =
      await ctx.runQuery(internal.pages.textByDocument, {
        documentId: args.documentId,
      });
    // Nothing to read is a finished document, not a stalled one.
    if (pages.length === 0) {
      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "relationships",
        status: "completed",
      });
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
        status: "completed",
      });
      return;
    }

    try {
      const documentText = pages
        .map((p) => `[Page ${p.pageNumber + 1}]\n${p.text}`)
        .join("\n\n");

      // What this project looks for beyond people and organizations. Read at
      // call time rather than stored with the document, so declaring a type
      // takes effect on the next document without a migration.
      const document = await ctx.runQuery(api.documents.get, {
        id: args.documentId,
      });
      const extraTypes = document?.projectId
        ? await ctx.runQuery(internal.projectEntityTypes.listInternal, {
            projectId: document.projectId,
          })
        : [];
      const schema = buildGraphSchema(extraTypes.map((t) => t.key));

      const { content } = await chatCompletion(apiKey, {
        usage: {
          log: usageLogger(ctx, { documentId: args.documentId }),
          operation: "relationships",
        },
        // Inference-heavy — worth Interfaze's reasoning mode (off by default
        // for straight extraction).
        reasoning: true,
        systemPrompt:
          "You are an analyst reading a document to find who is in it and how they are connected. " +
          "Work only from the text. Never invent an entity, a connection, a date, or a place. " +
          entityRule(extraTypes),
        content: [
          {
            type: "text",
            text: `Document text:\n\n${documentText}\n\nList every person and organization this document names, then every relationship between them that the text explicitly supports.`,
          },
        ],
        responseSchema: { name: "document_graph", schema },
      });

      const parsed = JSON.parse(content) as {
        entities?: Array<{ name?: string; type?: string; role?: string }>;
        relationships?: Array<{
          source_name?: string;
          target_name?: string;
          relation_type?: string;
          quote?: string;
          page_number?: number;
          event_date?: string;
          place?: string;
          confidence?: number;
        }>;
      };

      // One row per name. A repeated name with a second type is the model
      // contradicting itself, and the first answer is as good as the second —
      // but a repeat is also where a role can arrive, so the role is kept.
      const byName = new Map<
        string,
        { name: string; type: string; role?: string }
      >();
      for (const entity of parsed.entities ?? []) {
        const name = (entity.name ?? "").trim();
        const type = TYPE_MAP[entity.type ?? ""] ?? entity.type?.trim();
        if (!name || !type) continue;
        const key = name.toLowerCase();
        const role = (entity.role ?? "").trim().toLowerCase();
        const existing = byName.get(key);
        if (existing) {
          if (!existing.role && role) existing.role = role;
          continue;
        }
        byName.set(key, { name, type, role: role || undefined });
      }

      // Endpoints are resolved against that list rather than typed inline, so
      // a relationship naming someone the model never listed is dropped rather
      // than silently creating an untyped entity. Counted, because a high drop
      // rate means the entity list came back incomplete.
      let unlisted = 0;
      const relationships = [];
      for (const rel of parsed.relationships ?? []) {
        const sourceName = (rel.source_name ?? "").trim();
        const targetName = (rel.target_name ?? "").trim();
        const relationType = (rel.relation_type ?? "").trim();
        if (!sourceName || !targetName || !relationType) continue;
        if (sourceName.toLowerCase() === targetName.toLowerCase()) continue;
        if (
          !byName.has(sourceName.toLowerCase()) ||
          !byName.has(targetName.toLowerCase())
        ) {
          unlisted++;
          continue;
        }
        relationships.push({
          sourceName,
          targetName,
          relationType,
          quote: (rel.quote ?? "").slice(0, 500),
          pageNumber:
            typeof rel.page_number === "number" && rel.page_number >= 1
              ? rel.page_number - 1
              : undefined,
          eventDate: (rel.event_date ?? "").trim() || undefined,
          place: (rel.place ?? "").trim().slice(0, 120) || undefined,
          confidence: Math.min(1, Math.max(0, rel.confidence ?? 0.5)),
        });
      }
      if (unlisted > 0) {
        console.warn(
          `${unlisted} relationship(s) named entities missing from the entity list for ${args.documentId}`
        );
      }

      await ctx.runMutation(internal.relationships.ingestGraph, {
        documentId: args.documentId,
        entities: [...byName.values()],
        relationships,
      });

      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "relationships",
        status: "completed",
      });
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
        status: "completed",
      });
    } catch (e) {
      // This is the product now, not an enrichment pass beside it — a document
      // that reaches "completed" with no entities has nothing to show. So the
      // failure goes on the document, the way Extract's used to, which also
      // routes a provider block through failDocument and pauses the queue.
      const msg = e instanceof Error ? e.message : String(e);
      const code = failureCodeOf(e);
      await ctx.runMutation(internal.processing.markFailed, {
        documentId: args.documentId,
        errorMessage: code ? msg : `Entity mapping failed: ${msg}`,
        errorCode: code,
      });
    }
  },
});

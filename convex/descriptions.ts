/**
 * AI-written entity descriptions — the "Layer 2" bio lede.
 *
 * The generation input is the extracted fact rows (relationships + roles),
 * never the documents, so the description cannot say more than the extraction
 * proved; every sentence stores the fact rows that support it and renders
 * with their citations. Staleness is a hash comparison: `ensure` (called on
 * entity page view) hashes the current fact-row id set against what the
 * stored description summarizes, and schedules a regeneration only on
 * mismatch — so the thousands of entities nobody opens never cost a call,
 * and an unchanged fact set never re-generates (and would be a free vcache
 * hit if it did).
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authedMutation } from "./authz";
import { requireEntity } from "./ownership";
import { chatCompletion } from "./interfaze";
import { usageLogger } from "./apiLogs";
import { fnv1a } from "./hash";
import {
  buildDescriptionPrompt,
  parseDescriptionResponse,
  DESCRIPTION_SCHEMA,
  DESCRIPTION_SYSTEM_PROMPT,
  type RelationshipFactInput,
  type RoleFactInput,
} from "./descriptionPrompt";

/**
 * A claim older than this is re-armable: the Convex action kill at 10
 * minutes runs no catch, so a dead generation must not block retries.
 */
const QUEUE_CLAIM_MS = 15 * 60 * 1000;

/**
 * The fact rows a description summarizes, in a deterministic order (row id).
 * Shared by the hash (mutation) and the prompt (action) so they can never
 * disagree about what "the fact set" is.
 */
async function factRows(ctx: QueryCtx, entityId: Id<"entities">) {
  const asSource = await ctx.db
    .query("relationships")
    .withIndex("by_source", (q) => q.eq("sourceEntityId", entityId))
    .take(200);
  const asTarget = await ctx.db
    .query("relationships")
    .withIndex("by_target", (q) => q.eq("targetEntityId", entityId))
    .take(200);
  const relationships = [...asSource, ...asTarget].sort((a, b) =>
    a._id.localeCompare(b._id)
  );
  const roles = (
    await ctx.db
      .query("entityRoles")
      .withIndex("by_entity", (q) => q.eq("entityId", entityId))
      .take(200)
  ).sort((a, b) => a._id.localeCompare(b._id));
  return { relationships, roles };
}

function factsHashOf(
  relationships: Array<{ _id: Id<"relationships"> }>,
  roles: Array<{ _id: Id<"entityRoles"> }>
): string {
  return fnv1a(
    [...relationships.map((r) => r._id), ...roles.map((r) => r._id)].join("\0")
  );
}

/**
 * Called on entity page view: schedule a (re)generation iff the stored
 * description no longer matches the live fact set. Idempotent and cheap on
 * the common path — one hash comparison, no writes.
 */
export const ensure = authedMutation({
  args: { entityId: v.id("entities") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entity = await requireEntity(ctx, args.entityId);
    const { relationships, roles } = await factRows(ctx, args.entityId);

    if (relationships.length === 0 && roles.length === 0) {
      // Nothing to say; a stale description from facts since deleted goes.
      if (entity.description) {
        await ctx.db.patch(args.entityId, { description: undefined });
      }
      return null;
    }

    const hash = factsHashOf(relationships, roles);
    if (entity.description?.factsHash === hash) return null;
    if (
      entity.descriptionQueuedHash === hash &&
      entity.descriptionQueuedAt !== undefined &&
      Date.now() - entity.descriptionQueuedAt < QUEUE_CLAIM_MS
    ) {
      return null; // already in flight
    }

    await ctx.db.patch(args.entityId, {
      descriptionQueuedHash: hash,
      descriptionQueuedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.descriptions.generate, {
      entityId: args.entityId,
    });
    return null;
  },
});

/** Return shape of factsForGeneration — named to break same-file runQuery circularity. */
type GenerationFacts = {
  entity: { name: string; types: string[]; aliases: string[] };
  projectId: Id<"projects"> | null;
  factsHash: string;
  relationshipFacts: Array<RelationshipFactInput & { id: Id<"relationships"> }>;
  roleFacts: Array<RoleFactInput & { id: Id<"entityRoles"> }>;
};

export const factsForGeneration = internalQuery({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args): Promise<GenerationFacts | null> => {
    const entity = await ctx.db.get(args.entityId);
    if (!entity) return null;
    const { relationships, roles } = await factRows(ctx, args.entityId);

    const relationshipFacts: Array<
      RelationshipFactInput & { id: Id<"relationships"> }
    > = [];
    for (const [i, rel] of relationships.entries()) {
      const source =
        rel.sourceEntityId === args.entityId
          ? entity
          : await ctx.db.get(rel.sourceEntityId);
      const target =
        rel.targetEntityId === args.entityId
          ? entity
          : await ctx.db.get(rel.targetEntityId);
      if (!source || !target) continue;
      relationshipFacts.push({
        id: rel._id,
        key: `F${i + 1}`,
        subject: source.name,
        relation: rel.relationType,
        object: target.name,
        eventDate: rel.eventDate,
        place: rel.place,
        quote: rel.quote,
      });
    }

    const roleFacts: Array<RoleFactInput & { id: Id<"entityRoles"> }> = [];
    for (const [i, row] of roles.entries()) {
      const doc = await ctx.db.get(row.documentId);
      roleFacts.push({
        id: row._id,
        key: `R${i + 1}`,
        role: row.role,
        documentName: doc?.name,
      });
    }

    return {
      entity: {
        name: entity.name,
        types: entity.types ?? [entity.type],
        aliases: entity.aliases,
      },
      projectId: entity.projectId ?? null,
      factsHash: factsHashOf(relationships, roles),
      relationshipFacts,
      roleFacts,
    };
  },
});

export const generate = internalAction({
  args: { entityId: v.id("entities") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const apiKey = process.env.INTERFAZE_API_KEY;
    try {
      const facts = await ctx.runQuery(internal.descriptions.factsForGeneration, {
        entityId: args.entityId,
      });
      if (!facts || !apiKey) return null;
      if (facts.relationshipFacts.length === 0 && facts.roleFacts.length === 0)
        return null;

      const { content } = await chatCompletion(apiKey, {
        usage: {
          log: usageLogger(
            ctx,
            facts.projectId ? { projectId: facts.projectId } : undefined
          ),
          operation: "entity_description",
        },
        systemPrompt: DESCRIPTION_SYSTEM_PROMPT,
        content: [
          {
            type: "text",
            text: buildDescriptionPrompt(
              facts.entity,
              facts.relationshipFacts,
              facts.roleFacts
            ),
          },
        ],
        responseSchema: {
          name: "entity_description",
          schema: DESCRIPTION_SCHEMA,
        },
      });

      const relByKey = new Map(facts.relationshipFacts.map((f) => [f.key, f.id]));
      const roleByKey = new Map(facts.roleFacts.map((f) => [f.key, f.id]));
      const sentences = parseDescriptionResponse(
        content,
        new Set(relByKey.keys()),
        new Set(roleByKey.keys())
      ).map((s) => ({
        text: s.text,
        relationshipIds: s.relationshipKeys.map((k) => relByKey.get(k)!),
        roleIds: s.roleKeys.map((k) => roleByKey.get(k)!),
      }));

      await ctx.runMutation(internal.descriptions.store, {
        entityId: args.entityId,
        factsHash: facts.factsHash,
        sentences,
      });
    } catch (e) {
      // A description is a nicety; failure must not strand the claim, or the
      // entity can never try again until the claim expires.
      console.error("entity description generation failed:", e);
      await ctx.runMutation(internal.descriptions.clearQueued, {
        entityId: args.entityId,
      });
    }
    return null;
  },
});

export const store = internalMutation({
  args: {
    entityId: v.id("entities"),
    factsHash: v.string(),
    sentences: v.array(
      v.object({
        text: v.string(),
        relationshipIds: v.array(v.id("relationships")),
        roleIds: v.array(v.id("entityRoles")),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entity = await ctx.db.get(args.entityId);
    if (!entity) return null; // lost a merge while generating
    await ctx.db.patch(args.entityId, {
      // Every sentence gated to cited facts; zero survivors clears rather
      // than keeps a description the current facts no longer support.
      description:
        args.sentences.length > 0
          ? {
              sentences: args.sentences,
              factsHash: args.factsHash,
              generatedAt: Date.now(),
            }
          : undefined,
      descriptionQueuedHash: undefined,
      descriptionQueuedAt: undefined,
    });
    return null;
  },
});

export const clearQueued = internalMutation({
  args: { entityId: v.id("entities") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entity = await ctx.db.get(args.entityId);
    if (!entity) return null;
    await ctx.db.patch(args.entityId, {
      descriptionQueuedHash: undefined,
      descriptionQueuedAt: undefined,
    });
    return null;
  },
});

import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { resolveEntity, recountEntity } from "./entityResolution";
import type { Id } from "./_generated/dataModel";
import {
  canonicalizeRelation,
  relationLabel,
  relationSortIndex,
} from "./relationTypes";

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
        pageNumber: v.optional(v.number()),
        eventDate: v.optional(v.string()),
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

    // Resolve names through the shared resolver (exact/alias auto-link,
    // fuzzy lookalikes queue merge suggestions), then make sure the entity has
    // mentions in THIS document.
    //
    // Mention-backfill used to be gated on `created`, so an entity that already
    // existed (typically created by template extraction on another document)
    // got no mentions here: the relationship cited this document while the
    // entity was missing from its sidebar — entities.byDocument is
    // mention-driven — and absent from its documentCount.
    const resolved = new Map<string, Id<"entities">>();
    const resolve = async (
      name: string,
      legacyType: string
    ): Promise<Id<"entities">> => {
      const key = name.toLowerCase();
      const cached = resolved.get(key);
      if (cached) return cached;

      const stableType =
        { people: "person", organization: "organization", places: "place" }[
          legacyType
        ] ?? "other";
      const { entityId } = await resolveEntity(ctx, {
        name,
        stableType,
        documentId: args.documentId,
      });

      // Idempotent: template extraction may already have recorded this
      // entity's mentions for this document, and this mutation re-runs on
      // every relationship rebuild.
      const existingHere = await ctx.db
        .query("mentions")
        .withIndex("by_entity", (q) =>
          q.eq("entityId", entityId).eq("documentId", args.documentId)
        )
        .first();
      if (!existingHere) {
        const matchingBlocks = blocks.filter((b) =>
          b.text.toLowerCase().includes(key)
        );
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
        if (matchingBlocks.length > 0) await recountEntity(ctx, entityId);
      }
      resolved.set(key, entityId);
      return entityId;
    };

    // Dedupe identical (source, target, type) triples within this batch
    const seen = new Set<string>();
    for (const rel of args.relationships) {
      const sourceId = await resolve(rel.sourceName, rel.sourceType);
      const targetId = await resolve(rel.targetName, rel.targetType);
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
        pageNumber: rel.pageNumber,
        eventDate: rel.eventDate,
      });
    }
  },
});
// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Everything touching an entity, phrased from that entity's point of view.
 *
 * Relations are canonicalized on the way out (see convex/relationTypes.ts) so
 * `paid` and `made_payment_to` group together. The raw `relationType` is
 * returned alongside, because the document's own wording is the provenance and
 * the canonical id is only a display and grouping decision.
 *
 * `counterparties` is aggregated here rather than in the client: it needs both
 * index reads combined, and the client would otherwise re-derive it on every
 * render.
 */
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
      ...asSource.map((r) => ({ rel: r, otherId: r.targetEntityId, stored: "outgoing" as const })),
      ...asTarget.map((r) => ({ rel: r, otherId: r.sourceEntityId, stored: "incoming" as const })),
    ];

    const connections = [];
    for (const { rel, otherId, stored } of rows) {
      const other = await ctx.db.get(otherId);
      if (!other) continue;
      const doc = rel.documentId ? await ctx.db.get(rel.documentId) : null;

      // A phrase like "employs" states the canonical relation backwards, so the
      // endpoints swap: storing "X employs Y" and "Y works at X" must put both
      // under one heading rather than two mirrored ones.
      const canonical = canonicalizeRelation(rel.relationType);
      const direction = canonical.invert
        ? stored === "outgoing"
          ? ("incoming" as const)
          : ("outgoing" as const)
        : stored;

      connections.push({
        _id: rel._id,
        direction,
        canonicalId: canonical.id,
        canonicalKnown: canonical.known,
        label: relationLabel(canonical.id, direction),
        /** As the document worded it — kept for provenance, not for grouping. */
        relationType: rel.relationType,
        confidence: rel.confidence,
        quote: rel.quote,
        pageNumber: rel.pageNumber,
        eventDate: rel.eventDate,
        otherEntity: { _id: other._id, name: other.name, type: other.type },
        document: doc ? { _id: doc._id, name: doc.name } : null,
      });
    }

    // Strongest relation first, then most recent — so the money and employment
    // facts lead, and an undated assertion never outranks a dated one.
    connections.sort((a, b) => {
      const byRelation =
        relationSortIndex(a.canonicalId) - relationSortIndex(b.canonicalId);
      if (byRelation !== 0) return byRelation;
      return (b.eventDate ?? "").localeCompare(a.eventDate ?? "");
    });

    const tally = new Map<
      string,
      {
        entity: { _id: Id<"entities">; name: string; type: string };
        count: number;
        labels: string[];
      }
    >();
    for (const connection of connections) {
      const key = connection.otherEntity._id;
      const existing = tally.get(key);
      if (existing) {
        existing.count++;
        if (!existing.labels.includes(connection.label)) {
          existing.labels.push(connection.label);
        }
      } else {
        tally.set(key, {
          entity: connection.otherEntity,
          count: 1,
          labels: [connection.label],
        });
      }
    }
    const counterparties = [...tally.values()].sort(
      (a, b) => b.count - a.count || a.entity.name.localeCompare(b.entity.name)
    );

    return { connections, counterparties };
  },
});

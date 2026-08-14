import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  resolveEntity,
  recountEntity,
  LEGACY_TO_STABLE,
} from "./entityResolution";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canonicalizeRelation,
  relationLabel,
  relationSortIndex,
} from "./relationTypes";

// ---------------------------------------------------------------------------
// Mutation: resolve names to entities and store relationship rows
// ---------------------------------------------------------------------------

/**
 * Store one document's graph: the entities it names, then how they connect.
 *
 * Entities are resolved first and completely, so an entity that participates in
 * no relationship still lands — a person named once is still someone the reader
 * asked to see. The relationship loop then looks names up in that map rather
 * than resolving them itself, which is why an endpoint the model never listed
 * is dropped upstream instead of creating an untyped row here.
 */
export const ingestGraph = internalMutation({
  args: {
    documentId: v.id("documents"),
    entities: v.array(
      v.object({
        name: v.string(),
        /** Legacy `type` value — "people" | "organization" | project-declared. */
        type: v.string(),
        role: v.optional(v.string()),
      })
    ),
    relationships: v.array(
      v.object({
        sourceName: v.string(),
        targetName: v.string(),
        relationType: v.string(),
        quote: v.string(),
        pageNumber: v.optional(v.number()),
        eventDate: v.optional(v.string()),
        place: v.optional(v.string()),
        confidence: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    // This mutation writes entities, mentions, roles and edges without ever
    // touching the document row, so it is not covered by the "patch throws on a
    // deleted id" rollback every other ingest path relies on. Deleting a
    // document during the reasoning call would otherwise land a whole graph —
    // and inflated counts on surviving entities — for a document that is gone.
    if ((await ctx.db.get(args.documentId)) === null) return;

    // Re-run safety: replace this document's relationships
    const existing = await ctx.db
      .query("relationships")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const rel of existing) await ctx.db.delete(rel._id);

    if (args.entities.length === 0) return;

    // Re-run safety for entities, which is subtler than for relationships.
    //
    // entities.byDocument is mention-driven, so an entity keeps appearing in
    // this document's sidebar for exactly as long as it has a mention here —
    // regardless of whether the current pass named it. Leaving the old rows in
    // place meant every entity a previous vocabulary produced ("United States",
    // typed `places`) survived a re-run that no longer believes in it.
    //
    // Mentions are re-derived from blocks below, so dropping them is not a loss
    // of anything a human wrote. Counts are fixed up at the end, once the new
    // mentions exist, rather than twice per entity.
    const staleMentions = await ctx.db
      .query("mentions")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const touched = new Set<Id<"entities">>();
    for (const mention of staleMentions) {
      touched.add(mention.entityId);
      await ctx.db.delete(mention._id);
    }

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
    for (const entity of args.entities) {
      const key = entity.name.toLowerCase();
      if (resolved.has(key)) continue;

      const stableType = LEGACY_TO_STABLE[entity.type] ?? entity.type;
      const { entityId } = await resolveEntity(ctx, {
        name: entity.name,
        stableType,
        documentId: args.documentId,
      });

      // The contextual role this entity plays in this document, when the pass
      // named one. Never overwrites a human's answer, and never duplicates: a
      // re-run of the same document must not stack three "witness" rows.
      if (entity.role) {
        const already = await ctx.db
          .query("entityRoles")
          .withIndex("by_entity_and_document", (q) =>
            q.eq("entityId", entityId).eq("documentId", args.documentId)
          )
          .collect();
        if (!already.some((r) => r.role === entity.role)) {
          await ctx.db.insert("entityRoles", {
            entityId,
            documentId: args.documentId,
            role: entity.role,
            confidence: 1.0,
            source: "ai",
          });
        }
      }

      // Unconditional: this document's mentions were just cleared, so there is
      // nothing left to be idempotent about, and a stale gate here is what let
      // an entity keep a previous run's evidence.
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
      touched.add(entityId);
      resolved.set(key, entityId);
    }

    // Dedupe identical (source, target, type, date, place) rows within this
    // batch.
    //
    // The date is part of the key because leaving it out made two meetings
    // between the same pair on different dates collapse into one row, and the
    // survivor was whichever the model happened to emit first — silently
    // discarding the second date. Place is in the key for the same reason. The
    // quote is deliberately *not*: the model often supports one fact with two
    // different sentences, and those are duplicates worth collapsing.
    const seen = new Set<string>();
    for (const rel of args.relationships) {
      const sourceId = resolved.get(rel.sourceName.toLowerCase());
      const targetId = resolved.get(rel.targetName.toLowerCase());
      if (!sourceId || !targetId || sourceId === targetId) continue;

      const dedupKey = `${sourceId}:${targetId}:${rel.relationType}:${rel.eventDate ?? ""}:${rel.place ?? ""}`;
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
        place: rel.place,
      });
    }

    // Counts last, once for each entity this run touched — which includes the
    // ones it dropped. An entity that lost its only mentions here has to see
    // its documentCount fall, or it keeps claiming a document that no longer
    // names it.
    for (const entityId of touched) await recountEntity(ctx, entityId);
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
/**
 * Types worth showing in the document panel.
 *
 * Extraction still produces places and — via the suggested-extraction path,
 * which types entities by JSON schema key — rows typed `dates`, `parties` and
 * worse. Filtering here rather than at extraction keeps the change reversible
 * and the underlying data intact: this is a display decision until the
 * vocabulary itself is narrowed.
 */
const SHOWN_TYPES = new Set(["person", "organization"]);

function isShownType(entity: Doc<"entities">): boolean {
  // `types[]` is the stable vocabulary and wins when present; `type` is the
  // legacy value, which for rows minted by suggested extraction is an
  // arbitrary schema key that maps to nothing.
  const stable = entity.types?.length
    ? entity.types
    : [LEGACY_TO_STABLE[entity.type] ?? entity.type];
  return stable.some((t) => SHOWN_TYPES.has(t));
}

/**
 * Every relationship a single document asserts, between people and organizations.
 *
 * `forEntity` answers "what touches this person" and phrases each row from that
 * person's side. A document has no such subject, so both endpoints are named
 * and the row is always read left-to-right — which means an inverting phrase
 * ("X employs Y" for the canonical `employed_by`) swaps the endpoints here
 * rather than flipping the label.
 *
 * `hidden` is returned rather than silently dropped: a panel that quietly shows
 * a third of what it found reads as "this document has few connections".
 */
export const byDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("relationships")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .take(200);

    const connections = [];
    let hidden = 0;
    for (const rel of rows) {
      const source = await ctx.db.get(rel.sourceEntityId);
      const target = await ctx.db.get(rel.targetEntityId);
      if (!source || !target) continue;
      if (!isShownType(source) || !isShownType(target)) {
        hidden++;
        continue;
      }

      const canonical = canonicalizeRelation(rel.relationType);
      const [from, to] = canonical.invert ? [target, source] : [source, target];

      connections.push({
        _id: rel._id,
        canonicalId: canonical.id,
        canonicalKnown: canonical.known,
        /** Read from the source's side: "paid", "employed by". */
        label: relationLabel(canonical.id, "outgoing"),
        /**
         * The same fact read from the target's side: "was paid by". The
         * sidebar lists a connection beneath both endpoints, and a row filed
         * under the person who *received* the money must not say "paid".
         */
        inverseLabel: relationLabel(canonical.id, "incoming"),
        /** As the document worded it — provenance, not a grouping key. */
        relationType: rel.relationType,
        confidence: rel.confidence,
        quote: rel.quote,
        pageNumber: rel.pageNumber,
        eventDate: rel.eventDate,
        place: rel.place,
        source: { _id: from._id, name: from.name, type: from.type },
        target: { _id: to._id, name: to.name, type: to.type },
      });
    }

    // Same ordering as forEntity: strongest relation first, then most recent.
    connections.sort((a, b) => {
      const byRelation =
        relationSortIndex(a.canonicalId) - relationSortIndex(b.canonicalId);
      if (byRelation !== 0) return byRelation;
      return (b.eventDate ?? "").localeCompare(a.eventDate ?? "");
    });

    return { connections, hidden };
  },
});

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

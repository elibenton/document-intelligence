import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { TOTALS_SHARDS } from "./apiLogs";
import { LEGACY_TO_STABLE } from "./entityResolution";
import { detectMediaType } from "./upload";

/** Debug helper: inspect an entity's mention rows by name. */
export const debugEntityMentions = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (!entity) return null;
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_entity", (q) => q.eq("entityId", entity._id))
      .collect();
    return {
      entity: {
        name: entity.name,
        mentionCount: entity.mentionCount,
        documentCount: entity.documentCount,
      },
      mentionRows: mentions.map((m) => ({
        documentId: m.documentId,
        pageNumber: m.pageNumber,
        blockId: m.blockId,
        text: m.text.slice(0, 120),
      })),
    };
  },
});

/**
 * One-off backfill for the mental-model schema changes:
 *  - documents get a mediaType derived from mimeType
 *  - entities get stable `types` derived from the legacy `type`
 * Safe to re-run; only touches rows missing the new fields.
 */
export const backfillMentalModel = internalMutation({
  args: {},
  handler: async (ctx) => {
    let docsPatched = 0;
    for await (const doc of ctx.db.query("documents")) {
      if (doc.mediaType) continue;
      // Shared with the upload path so the two can't drift.
      await ctx.db.patch(doc._id, {
        mediaType: detectMediaType(doc.mimeType, doc.name),
      });
      docsPatched++;
    }

    let entitiesPatched = 0;
    for await (const entity of ctx.db.query("entities")) {
      if (entity.types && entity.types.length > 0) continue;
      const stable = LEGACY_TO_STABLE[entity.type] ?? "other";
      await ctx.db.patch(entity._id, { types: [stable] });
      entitiesPatched++;
    }

    return { docsPatched, entitiesPatched };
  },
});

/**
 * One-off backfill for the projects layer: creates (or reuses) a "Test
 * Project" and stamps every document, entity, story, and search that has no
 * projectId yet. Safe to re-run.
 */
export const backfillProjects = internalMutation({
  args: {},
  handler: async (ctx) => {
    let project = await ctx.db
      .query("projects")
      .withIndex("by_slug", (q) => q.eq("slug", "test-project"))
      .unique();
    if (!project) {
      const projectId = await ctx.db.insert("projects", {
        name: "Test Project",
        slug: "test-project",
        description: "All pre-projects data, migrated automatically.",
        createdAt: Date.now(),
      });
      project = (await ctx.db.get(projectId))!;
    }

    const counts = { documents: 0, entities: 0, searches: 0 };
    for (const table of ["documents", "entities", "searches"] as const) {
      for await (const row of ctx.db.query(table)) {
        if (row.projectId) continue;
        await ctx.db.patch(row._id, { projectId: project._id });
        counts[table]++;
      }
    }

    return { projectId: project._id, ...counts };
  },
});

/**
 * COMPLETED MIGRATION — `pages.markdownText` → `pages.text`.
 *
 * Done as widen → migrate → narrow: the schema briefly carried both fields,
 * a copy pass filled `text` on all 605 pages (and cleared the deprecated
 * `documents.datalabCheckpointId` off 11 documents), a strip pass then UNSET
 * the old key on all 605 (copying alone is not enough — Convex rejects rows
 * carrying a field the validator does not declare), and the schema was
 * narrowed to a required `pages.text`. Both migration mutations are deleted;
 * this note is the tombstone.
 */

/**
 * Backfill for the cache-hit costing fix (see convex/interfazeCost.ts).
 *
 * A completion served from Interfaze's semantic cache is not charged, but it
 * still reports its full token counts, and the logger used to cost those at
 * list price. Every row written before the fix therefore carries a cost the
 * account was never billed — $6.31 of the first $31.93, across 129 hits — and
 * `apiUsageTotals`, which is a running sum of exactly that field, inherited it.
 *
 * Token counts are left alone: they are an accurate record of the work the
 * pipeline asked for, which is what capacity and prompt-size questions read.
 * Only the dollars move.
 *
 * Re-runnable. Each batch zeroes the rows it finds and takes the same amount
 * back out of the fattest totals shard, so an interrupted run leaves the ledger
 * self-consistent rather than double-counted; a second run finds nothing to fix
 * and subtracts nothing.
 */
export const backfillCacheHitCosts = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("apiLogs").paginate({
      numItems: args.batchSize ?? 200,
      cursor: args.cursor ?? null,
    });

    let rowsFixed = 0;
    let usdRemoved = 0;
    for (const row of page.page) {
      if (row.cacheHit !== true || row.costUsd === 0) continue;
      usdRemoved += row.costUsd;
      await ctx.db.patch(row._id, { costUsd: 0 });
      rowsFixed++;
    }

    if (usdRemoved > 0) {
      // Take it off the largest shard so the correction cannot drive a shard
      // negative while the sum across shards stays exact.
      const shards = await ctx.db.query("apiUsageTotals").take(TOTALS_SHARDS + 1);
      const fattest = shards.reduce(
        (best, shard) => (best && best.costUsd >= shard.costUsd ? best : shard),
        shards[0]
      );
      if (fattest) {
        await ctx.db.patch(fattest._id, {
          costUsd: fattest.costUsd - usdRemoved,
        });
      }
    }

    return {
      rowsFixed,
      usdRemoved,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

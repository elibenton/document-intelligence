import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
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

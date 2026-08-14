import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { slugify } from "./slug";

/**
 * Fill in `entities.slug` for rows written before the field existed, so
 * `/entity/:slug` resolves them through `by_slug_and_project`.
 *
 * Run once, after the schema push:
 *   npx convex run migrations:backfillEntitySlugs
 *
 * It re-schedules itself a page at a time rather than walking the table in one
 * transaction, and skips rows that already carry a slug — so it is safe to run
 * again, and safe to run while extraction is writing new entities.
 */
export const backfillEntitySlugs = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("entities")
      .paginate({ cursor: args.cursor ?? null, numItems: 200 });

    for (const entity of page.page) {
      if (entity.slug !== undefined) continue;
      await ctx.db.patch(entity._id, { slug: slugify(entity.name) });
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillEntitySlugs, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});


/**
 * Copy each page's project down from its document, for rows written before
 * `pages.projectId` / `pageTranslations.projectId` existed.
 *
 * Run once, after the schema push that adds the (optional) fields, and BEFORE
 * the one that adds `projectId` to the search/vector `filterFields`: a filtered
 * index never matches a row where the field is undefined, so searching a
 * half-backfilled corpus would silently return only the pages that had already
 * been converted.
 *
 *   npx convex run migrations:backfillPageProjectIds
 *
 * Same shape as the slug backfill — one page of rows per transaction, skipping
 * rows that already carry a project, so it is safe to re-run and safe to run
 * while ingestion is writing new pages.
 */
export const backfillPageProjectIds = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    table: v.optional(
      v.union(v.literal("pages"), v.literal("pageTranslations"))
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const table = args.table ?? "pages";
    const batch = await ctx.db
      .query(table)
      .paginate({ cursor: args.cursor ?? null, numItems: 200 });

    // One document row serves every page of that document in this batch.
    const projectByDoc = new Map<Id<"documents">, Id<"projects"> | undefined>();
    for (const row of batch.page as Array<Doc<"pages" | "pageTranslations">>) {
      if (row.projectId !== undefined) continue;
      let projectId = projectByDoc.get(row.documentId);
      if (!projectByDoc.has(row.documentId)) {
        projectId = (await ctx.db.get(row.documentId))?.projectId;
        projectByDoc.set(row.documentId, projectId);
      }
      // A page whose document is gone, or whose document has no project, has
      // nothing to inherit — leaving it undefined keeps it out of every
      // project-scoped search, which is the correct answer for an orphan.
      if (projectId === undefined) continue;
      await ctx.db.patch(row._id, { projectId });
    }

    if (!batch.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.backfillPageProjectIds,
        { cursor: batch.continueCursor, table }
      );
    } else if (table === "pages") {
      // Chain straight into the translations table so one command does both.
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.backfillPageProjectIds,
        { cursor: null, table: "pageTranslations" }
      );
    }
    return null;
  },
});

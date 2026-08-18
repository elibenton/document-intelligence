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
 * Give every pre-auth project an owner.
 *
 * Projects created before authentication existed carry no `ownerId`, and an
 * unowned project is invisible to everyone (convex/ownership.ts fails closed),
 * so this has to run before the app is usable again:
 *
 *   npx convex run migrations:backfillProjectOwners '{"ownerId":"<user id>"}'
 *
 * The id is a Better Auth user `_id` from the component's `user` table, not an
 * `Id<"users">` — there is no such table here. Take it from the component
 * rather than typing an email: this field is compared against `ctx.user._id`,
 * and an email would never match.
 *
 * No pagination and no self-rescheduling, unlike its neighbours above: this
 * table holds one row per project, it is the tenancy root rather than a leaf,
 * and a single transaction covers it with room to spare. Re-running is safe —
 * projects that already have an owner are left alone, so this never
 * reassigns a project away from whoever owns it now.
 */
export const backfillProjectOwners = internalMutation({
  args: { ownerId: v.string() },
  returns: v.object({ claimed: v.number(), alreadyOwned: v.number() }),
  handler: async (ctx, args) => {
    const projects = await ctx.db.query("projects").collect();
    let claimed = 0;
    let alreadyOwned = 0;
    for (const project of projects) {
      if (project.ownerId !== undefined) {
        alreadyOwned++;
        continue;
      }
      await ctx.db.patch(project._id, { ownerId: args.ownerId });
      claimed++;
    }
    return { claimed, alreadyOwned };
  },
});

/**
 * Attribute existing API log rows to the account that caused them, so the
 * admin dashboard is not almost entirely "Unattributed" on its first day.
 *
 * Run after backfillProjectOwners — it reads the owner this writes:
 *   npx convex run migrations:backfillApiLogOwners
 *
 * Same shape as backfillPageProjectIds, including the per-document memo: one
 * 20-page ingest writes ~28 log rows pointing at the same document, so
 * resolving the project once per document rather than once per row is most of
 * the work saved. Rows whose document or project is gone stay unattributed,
 * which is the right answer for an orphan, and rows already carrying an owner
 * are skipped — so this is safe to re-run and safe to run while the pipeline
 * is still logging.
 */
export const backfillApiLogOwners = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("apiLogs")
      .paginate({ cursor: args.cursor ?? null, numItems: 200 });

    const ownerByProject = new Map<Id<"projects">, string | undefined>();
    const projectByDoc = new Map<Id<"documents">, Id<"projects"> | undefined>();

    for (const row of batch.page) {
      if (row.ownerId !== undefined || !row.documentId) continue;
      if (!projectByDoc.has(row.documentId)) {
        projectByDoc.set(
          row.documentId,
          (await ctx.db.get(row.documentId))?.projectId
        );
      }
      const projectId = projectByDoc.get(row.documentId);
      if (projectId === undefined) continue;
      if (!ownerByProject.has(projectId)) {
        ownerByProject.set(projectId, (await ctx.db.get(projectId))?.ownerId);
      }
      const ownerId = ownerByProject.get(projectId);
      if (ownerId === undefined) continue;
      await ctx.db.patch(row._id, { ownerId });
    }

    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillApiLogOwners, {
        cursor: batch.continueCursor,
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



/**
 * Delete orphaned "Speaker N" entities.
 *
 * Recordings mirror their transcript into page text as "Speaker 1 [12s]: …",
 * so the entity pass could read a diarization label as a person and
 * `resolveEntity` — which matches by exact name within a project — would then
 * collapse every recording in that project onto one shared entity.
 * `relationshipsNode` now drops these before ingest; this clears the ones
 * written before it did.
 *
 * Run once:
 *   npx convex run migrations:dropSpeakerPlaceholderEntities
 *
 * Deliberately conservative: an entity is removed only when nothing references
 * it — no mentions, no roles, no relationships, no merge suggestions. Anything
 * still referenced is left alone and counted, because a real merge may have
 * folded genuine evidence onto that row and deleting it would take the evidence
 * with it. `searches.matchedEntities` is not consulted: it is a denormalized
 * cache of past results carrying its own name and type, so a stale chip still
 * renders.
 */
export const dropSpeakerPlaceholderEntities = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("entities")
      .paginate({ cursor: args.cursor ?? null, numItems: 100 });

    let dropped = 0;
    let kept = 0;
    for (const entity of page.page) {
      if (!/^speaker[\s_-]?\d+$/i.test(entity.name)) continue;

      const [mention, role, asSource, asTarget, mergeFrom, mergeTo] =
        await Promise.all([
          ctx.db
            .query("mentions")
            .withIndex("by_entity", (q) => q.eq("entityId", entity._id))
            .first(),
          ctx.db
            .query("entityRoles")
            .withIndex("by_entity", (q) => q.eq("entityId", entity._id))
            .first(),
          ctx.db
            .query("relationships")
            .withIndex("by_source", (q) => q.eq("sourceEntityId", entity._id))
            .first(),
          ctx.db
            .query("relationships")
            .withIndex("by_target", (q) => q.eq("targetEntityId", entity._id))
            .first(),
          ctx.db
            .query("mergeSuggestions")
            .withIndex("by_source_and_target", (q) =>
              q.eq("sourceEntityId", entity._id)
            )
            .first(),
          ctx.db
            .query("mergeSuggestions")
            .withIndex("by_target", (q) => q.eq("targetEntityId", entity._id))
            .first(),
        ]);

      if (mention || role || asSource || asTarget || mergeFrom || mergeTo) {
        kept++;
        continue;
      }
      await ctx.db.delete(entity._id);
      dropped++;
    }
    if (dropped > 0 || kept > 0) {
      console.log(
        `dropSpeakerPlaceholderEntities: removed ${dropped}, kept ${kept} still referenced`
      );
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.dropSpeakerPlaceholderEntities,
        { cursor: page.continueCursor }
      );
    }
    return null;
  },
});

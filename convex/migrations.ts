import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
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

import { v } from "convex/values";
import { authedQuery } from "./authz";
import { requireEntity } from "./ownership";

/** Roles an entity plays, grouped with the asserting document's name. */
export const forEntity = authedQuery({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args) => {
    await requireEntity(ctx, args.entityId);
    const rows = await ctx.db
      .query("entityRoles")
      .withIndex("by_entity", (q) => q.eq("entityId", args.entityId))
      .take(200);
    const results = [];
    for (const row of rows) {
      const doc = await ctx.db.get(row.documentId);
      results.push({
        _id: row._id,
        role: row.role,
        confidence: row.confidence,
        source: row.source,
        document: doc ? { _id: doc._id, name: doc.name } : null,
      });
    }
    return results;
  },
});

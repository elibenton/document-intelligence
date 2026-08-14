import { v } from "convex/values";
import { authedMutation, authedQuery } from "./authz";

/** Roles an entity plays, grouped with the asserting document's name. */
export const forEntity = authedQuery({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args) => {
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

/** Role rows for a document, hydrated with entity names (sidebar display). */
export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("entityRoles")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .take(500);
    const results = [];
    for (const row of rows) {
      const entity = await ctx.db.get(row.entityId);
      if (!entity) continue;
      results.push({
        _id: row._id,
        role: row.role,
        confidence: row.confidence,
        source: row.source,
        entity: { _id: entity._id, name: entity.name },
      });
    }
    return results;
  },
});

/** Human edit: add a role for an entity on a document. */
export const addRole = authedMutation({
  args: {
    entityId: v.id("entities"),
    documentId: v.id("documents"),
    role: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("entityRoles")
      .withIndex("by_entity_and_document", (q) =>
        q.eq("entityId", args.entityId).eq("documentId", args.documentId)
      )
      .collect();
    if (existing.some((r) => r.role === args.role)) return;
    await ctx.db.insert("entityRoles", {
      entityId: args.entityId,
      documentId: args.documentId,
      role: args.role,
      confidence: 1.0,
      source: "human",
    });
  },
});

export const removeRole = authedMutation({
  args: { id: v.id("entityRoles") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

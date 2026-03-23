import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Query: get research dossiers for a document
// ---------------------------------------------------------------------------

export const byDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("research")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
  },
});

export const byDocumentEntity = query({
  args: {
    documentId: v.id("documents"),
    entityName: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("research")
      .withIndex("by_document_entity", (q) =>
        q.eq("documentId", args.documentId).eq("entityName", args.entityName)
      )
      .first();
  },
});

// ---------------------------------------------------------------------------
// Internal mutations: save research results
// ---------------------------------------------------------------------------

export const saveResult = internalMutation({
  args: {
    researchId: v.id("research"),
    content: v.string(),
    citations: v.array(v.string()),
    searchResults: v.optional(
      v.array(
        v.object({
          title: v.string(),
          url: v.string(),
          snippet: v.string(),
        })
      )
    ),
    status: v.string(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.researchId, {
      content: args.content,
      citations: args.citations,
      searchResults: args.searchResults,
      status: args.status,
      errorMessage: args.errorMessage,
    });
  },
});

export const createPending = internalMutation({
  args: {
    documentId: v.id("documents"),
    entityName: v.string(),
    query: v.string(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    // Delete existing research for this entity on this document
    const existing = await ctx.db
      .query("research")
      .withIndex("by_document_entity", (q) =>
        q.eq("documentId", args.documentId).eq("entityName", args.entityName)
      )
      .collect();
    for (const doc of existing) {
      await ctx.db.delete(doc._id);
    }

    return ctx.db.insert("research", {
      documentId: args.documentId,
      entityName: args.entityName,
      query: args.query,
      content: "",
      citations: [],
      model: args.model,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

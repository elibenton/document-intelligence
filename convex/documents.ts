import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("documents")
      .withIndex("by_uploadedAt")
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

export const remove = mutation({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return;

    // Delete the stored PDF
    await ctx.storage.delete(doc.storageId);

    // Delete related rows
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const page of pages) {
      // Delete blocks for this page
      const blocks = await ctx.db
        .query("blocks")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .collect();
      for (const block of blocks) await ctx.db.delete(block._id);
      await ctx.db.delete(page._id);
    }

    const extractions = await ctx.db
      .query("extractions")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const ext of extractions) await ctx.db.delete(ext._id);

    const jobs = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const job of jobs) await ctx.db.delete(job._id);

    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();

    // Track affected entities to update their counts
    const affectedEntityIds = new Set(mentions.map((m) => m.entityId));

    for (const m of mentions) await ctx.db.delete(m._id);

    // Update entity counts and clean up orphaned entities
    for (const entityId of affectedEntityIds) {
      const entity = await ctx.db.get(entityId);
      if (!entity) continue;

      // Count remaining mentions and unique documents
      const remainingMentions = await ctx.db
        .query("mentions")
        .withIndex("by_entity", (q) => q.eq("entityId", entityId))
        .collect();

      if (remainingMentions.length === 0) {
        // No more mentions — delete relationships referencing this entity
        const sourceRels = await ctx.db
          .query("relationships")
          .withIndex("by_source", (q) => q.eq("sourceEntityId", entityId))
          .collect();
        for (const rel of sourceRels) await ctx.db.delete(rel._id);

        const targetRels = await ctx.db
          .query("relationships")
          .withIndex("by_target", (q) => q.eq("targetEntityId", entityId))
          .collect();
        for (const rel of targetRels) await ctx.db.delete(rel._id);

        // Delete the entity itself
        await ctx.db.delete(entityId);
      } else {
        const remainingDocs = new Set(
          remainingMentions.map((m) => m.documentId)
        );
        await ctx.db.patch(entityId, {
          mentionCount: remainingMentions.length,
          documentCount: remainingDocs.size,
        });
      }
    }

    // Delete research dossiers for this document
    const research = await ctx.db
      .query("research")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const r of research) await ctx.db.delete(r._id);

    // Remove from any stories
    const storyLinks = await ctx.db
      .query("storyDocuments")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const link of storyLinks) await ctx.db.delete(link._id);

    // Delete the document itself
    await ctx.db.delete(args.id);
  },
});

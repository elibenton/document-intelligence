import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Called by Modal after OCR completes
export const ingestOcrResults = internalMutation({
  args: {
    documentId: v.id("documents"),
    pages: v.array(
      v.object({
        pageNumber: v.number(),
        markdownText: v.string(),
        width: v.number(),
        height: v.number(),
        textBlocks: v.array(
          v.object({
            text: v.string(),
            bbox: v.object({
              x: v.number(),
              y: v.number(),
              width: v.number(),
              height: v.number(),
            }),
            blockType: v.string(),
            confidence: v.optional(v.number()),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    // Update document with page count
    await ctx.db.patch(args.documentId, {
      pageCount: args.pages.length,
      status: "ner_processing",
    });

    // Update OCR processing job
    const ocrJob = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", "ocr")
      )
      .first();
    if (ocrJob) {
      await ctx.db.patch(ocrJob._id, {
        status: "completed",
        completedAt: Date.now(),
      });
    }

    // Create NER processing job
    await ctx.db.insert("processingJobs", {
      documentId: args.documentId,
      stage: "ner",
      status: "pending",
    });

    // Insert pages and text blocks
    for (const page of args.pages) {
      const pageId = await ctx.db.insert("pages", {
        documentId: args.documentId,
        pageNumber: page.pageNumber,
        markdownText: page.markdownText,
        width: page.width,
        height: page.height,
      });

      for (const block of page.textBlocks) {
        await ctx.db.insert("textBlocks", {
          documentId: args.documentId,
          pageId,
          pageNumber: page.pageNumber,
          text: block.text,
          bbox: block.bbox,
          blockType: block.blockType,
          confidence: block.confidence,
        });
      }
    }
  },
});

// Called by Modal after NER completes
export const ingestNerResults = internalMutation({
  args: {
    documentId: v.id("documents"),
    entities: v.array(
      v.object({
        canonicalName: v.string(),
        type: v.string(),
        aliases: v.array(v.string()),
        isCustom: v.boolean(),
        mentions: v.array(
          v.object({
            pageNumber: v.number(),
            text: v.string(),
            confidence: v.number(),
            bbox: v.optional(
              v.object({
                x: v.number(),
                y: v.number(),
                width: v.number(),
                height: v.number(),
              })
            ),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    // Get page IDs for this document
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const pageIdByNumber = new Map(pages.map((p) => [p.pageNumber, p._id]));

    for (const entityData of args.entities) {
      // Check if entity already exists (cross-document exact-name dedup)
      const existing = await ctx.db
        .query("entities")
        .withIndex("by_name", (q) => q.eq("name", entityData.canonicalName))
        .first();

      let entityId;
      if (existing && existing.type === entityData.type) {
        // Merge into existing entity
        const newAliases = [
          ...new Set([...existing.aliases, ...entityData.aliases]),
        ];
        const totalMentions = existing.mentionCount + entityData.mentions.length;
        const newDocCount = existing.documentCount + 1;
        const totalConfidence =
          existing.avgConfidence * existing.mentionCount +
          entityData.mentions.reduce((sum, m) => sum + m.confidence, 0);

        await ctx.db.patch(existing._id, {
          aliases: newAliases,
          mentionCount: totalMentions,
          documentCount: newDocCount,
          avgConfidence: totalConfidence / totalMentions,
        });
        entityId = existing._id;
      } else {
        // Create new entity
        const avgConfidence =
          entityData.mentions.reduce((sum, m) => sum + m.confidence, 0) /
          entityData.mentions.length;

        entityId = await ctx.db.insert("entities", {
          name: entityData.canonicalName,
          type: entityData.type,
          mentionCount: entityData.mentions.length,
          documentCount: 1,
          avgConfidence,
          aliases: entityData.aliases,
          isCustom: entityData.isCustom,
        });
      }

      // Insert mentions
      for (const mention of entityData.mentions) {
        const pageId = pageIdByNumber.get(mention.pageNumber);
        if (!pageId) continue;

        await ctx.db.insert("mentions", {
          entityId,
          documentId: args.documentId,
          pageId,
          pageNumber: mention.pageNumber,
          text: mention.text,
          confidence: mention.confidence,
          bbox: mention.bbox,
        });
      }
    }

    // Update NER processing job
    const nerJob = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", "ner")
      )
      .first();
    if (nerJob) {
      await ctx.db.patch(nerJob._id, {
        status: "completed",
        completedAt: Date.now(),
      });
    }

    // Mark document as completed
    await ctx.db.patch(args.documentId, {
      status: "completed",
      completedAt: Date.now(),
    });
  },
});

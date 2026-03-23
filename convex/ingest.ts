import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Ingest parse (convert) results
// ---------------------------------------------------------------------------

export const ingestParseResults = internalMutation({
  args: {
    documentId: v.id("documents"),
    markdown: v.string(),
    blocks: v.array(
      v.object({
        blockId: v.string(),
        blockType: v.string(),
        text: v.string(),
        html: v.optional(v.string()),
        pageNumber: v.number(),
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
    pageDimensions: v.optional(
      v.array(
        v.object({
          page: v.number(),
          width: v.number(),
          height: v.number(),
        })
      )
    ),
    pageCount: v.number(),
    checkpointId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, {
      pageCount: args.pageCount,
      ...(args.checkpointId
        ? { datalabCheckpointId: args.checkpointId }
        : {}),
    });

    // Build a page dimensions lookup
    const dimsByPage = new Map<number, { width: number; height: number }>();
    for (const dim of args.pageDimensions ?? []) {
      dimsByPage.set(dim.page, { width: dim.width, height: dim.height });
    }

    const blocksByPage = new Map<number, typeof args.blocks>();
    for (const block of args.blocks) {
      const pageBlocks = blocksByPage.get(block.pageNumber) ?? [];
      pageBlocks.push(block);
      blocksByPage.set(block.pageNumber, pageBlocks);
    }

    const pageTexts = args.markdown.split(/\n{0,2}---\n{0,2}/);

    for (let pageNum = 0; pageNum < args.pageCount; pageNum++) {
      const markdownText = pageTexts[pageNum] ?? "";
      const dims = dimsByPage.get(pageNum);
      const pageId = await ctx.db.insert("pages", {
        documentId: args.documentId,
        pageNumber: pageNum,
        markdownText: markdownText.trim(),
        ...(dims ? { width: dims.width, height: dims.height } : {}),
      });

      // Insert blocks for this page
      const pageBlocks = blocksByPage.get(pageNum) ?? [];
      for (const block of pageBlocks) {
        await ctx.db.insert("blocks", {
          documentId: args.documentId,
          pageId,
          pageNumber: pageNum,
          blockId: block.blockId,
          blockType: block.blockType,
          text: block.text,
          html: block.html,
          bbox: block.bbox,
        });
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Ingest extract results + populate entities and mentions
// ---------------------------------------------------------------------------

export const ingestExtractResults = internalMutation({
  args: {
    documentId: v.id("documents"),
    schemaUsed: v.string(),
    results: v.string(),
    pageRange: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Store raw extraction
    await ctx.db.insert("extractions", {
      documentId: args.documentId,
      schemaUsed: args.schemaUsed,
      results: args.results,
      pageRange: args.pageRange,
      extractedAt: Date.now(),
    });

    // Parse extraction results into entity entries
    let schema: Record<string, unknown>;
    let results: Record<string, unknown>;
    try {
      schema = JSON.parse(args.schemaUsed);
      results = JSON.parse(args.results);
    } catch {
      // If parsing fails, still mark complete
      await ctx.db.patch(args.documentId, {
        status: "completed",
        completedAt: Date.now(),
      });
      return;
    }

    const properties = (schema as { properties?: Record<string, unknown> })
      .properties ?? {};
    const entries: { name: string; type: string }[] = [];

    for (const key of Object.keys(properties)) {
      const val = results[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string" && item.trim()) {
            entries.push({ name: item.trim(), type: key });
          }
        }
      }
    }

    if (entries.length > 0) {
      // Load blocks and pages for this document to create mentions
      const blocks = await ctx.db
        .query("blocks")
        .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
        .collect();

      const pages = await ctx.db
        .query("pages")
        .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
        .collect();

      // Build pageNumber → pageId lookup
      const pageIdByNumber = new Map<number, typeof pages[0]["_id"]>();
      for (const page of pages) {
        pageIdByNumber.set(page.pageNumber, page._id);
      }

      // Process each unique entity
      const processed = new Set<string>(); // track by "type:lowercasename"

      for (const entry of entries) {
        const dedupKey = `${entry.type}:${entry.name.toLowerCase()}`;
        if (processed.has(dedupKey)) continue;
        processed.add(dedupKey);

        // Find or create entity
        // Use by_name index for exact match, then check case-insensitive
        const candidates = await ctx.db
          .query("entities")
          .withIndex("by_name", (q) => q.eq("name", entry.name))
          .collect();

        let entity: (typeof candidates)[number] | null = candidates[0] ?? null;

        // If no exact match, search case-insensitively via the search index
        if (!entity) {
          const searchResults = await ctx.db
            .query("entities")
            .withSearchIndex("search_name", (q) =>
              q.search("name", entry.name).eq("type", entry.type)
            )
            .take(10);

          entity =
            searchResults.find(
              (e) => e.name.toLowerCase() === entry.name.toLowerCase()
            ) ?? null;
        }

        // Delete existing mentions for this entity+document (handle re-extraction)
        if (entity) {
          const existingMentions = await ctx.db
            .query("mentions")
            .withIndex("by_entity", (q) =>
              q.eq("entityId", entity!._id).eq("documentId", args.documentId)
            )
            .collect();
          for (const m of existingMentions) {
            await ctx.db.delete(m._id);
          }
        }

        // Find blocks containing this entity (case-insensitive substring)
        const nameLower = entry.name.toLowerCase();
        const matchingBlocks = blocks.filter((b) =>
          b.text.toLowerCase().includes(nameLower)
        );

        const mentionCount = matchingBlocks.length;

        if (entity) {
          // Check if this document is new for this entity
          const otherMentions = await ctx.db
            .query("mentions")
            .withIndex("by_entity", (q) => q.eq("entityId", entity!._id))
            .take(1);

          // We just deleted mentions for this doc, so any remaining are from other docs
          const hadOtherDocs = otherMentions.length > 0;

          // Recalculate: we need the total mention count across all docs
          const allMentions = await ctx.db
            .query("mentions")
            .withIndex("by_entity", (q) => q.eq("entityId", entity!._id))
            .collect();

          const otherDocIds = new Set(allMentions.map((m) => m.documentId));
          otherDocIds.add(args.documentId); // Add current doc

          await ctx.db.patch(entity._id, {
            mentionCount: allMentions.length + mentionCount,
            documentCount: otherDocIds.size,
          });
        } else {
          // Create new entity
          const entityId = await ctx.db.insert("entities", {
            name: entry.name,
            type: entry.type,
            mentionCount: mentionCount,
            documentCount: 1,
            avgConfidence: 1.0,
            aliases: [],
            isCustom: entry.type !== "people",
          });
          entity = { _id: entityId } as unknown as NonNullable<typeof entity>;
        }

        // Insert mention rows
        for (const block of matchingBlocks) {
          const pageId = pageIdByNumber.get(block.pageNumber);
          if (!pageId || !entity) continue;

          await ctx.db.insert("mentions", {
            entityId: entity._id,
            documentId: args.documentId,
            pageId,
            pageNumber: block.pageNumber,
            text: block.text,
            confidence: 1.0,
            blockId: block.blockId,
            bbox: block.bbox,
          });
        }
      }
    }

    // Mark document completed
    await ctx.db.patch(args.documentId, {
      status: "completed",
      completedAt: Date.now(),
    });
  },
});

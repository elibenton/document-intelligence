import { v } from "convex/values";
import { authedMutation, authedQuery } from "./authz";
import { requireBlock, requireDocument } from "./ownership";

/**
 * All blocks for a document, WITHOUT the heavy fields (`words`, `html`).
 * Per-word OCR boxes dominate the payload — for a large scanned document
 * they can be tens of MB, which both blows past query limits and floods the
 * client on every reactive update. Used for TOC, search, and mention counts;
 * overlays that need word boxes fetch a single page via `byDocumentPage`.
 */
export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    // This is a lightweight navigation/search summary, not the overlay data
    // source. Dense born-digital PDFs can contain tens of thousands of PDF.js
    // text items; keep this subscription bounded while each visible page
    // fetches its complete geometry through byDocumentPage below.
    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .take(6_000);
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const sourceByPage = new Map(
      pages.map((page) => [page.pageNumber, page.textSource])
    );
    return blocks
      .filter((block) =>
        sourceByPage.get(block.pageNumber) === "pdf"
          ? block.source === "pdf"
          : block.source !== "pdf"
      )
      .map(({ words, html, ...rest }) => {
        void words;
        void html;
        return rest;
      });
  },
});

/** Full blocks (including word-level OCR boxes) for a single page — cheap
 * because only the handful of pages currently rendered subscribe to it. */
export const byDocumentPage = authedQuery({
  args: { documentId: v.id("documents"), pageNumber: v.number() },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    const page = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("pageNumber", args.pageNumber)
      )
      .first();
    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("pageNumber", args.pageNumber)
      )
      .collect();
    return blocks.filter((block) =>
      page?.textSource === "pdf"
        ? block.source === "pdf"
        : block.source !== "pdf"
    );
  },
});

export const updateType = authedMutation({
  args: { id: v.id("blocks"), blockType: v.string() },
  handler: async (ctx, args) => {
    await requireBlock(ctx, args.id);
    await ctx.db.patch(args.id, { blockType: args.blockType });
  },
});

// ---------------------------------------------------------------------------
// Locate a quote inside a document: find the OCR block that best matches the
// text and return everything a hover preview needs (page, bbox, dims, file).
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();

export const locateText = authedQuery({
  args: { documentId: v.id("documents"), text: v.string() },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    const target = norm(args.text);
    if (!target) return null;
    const targetTokens = new Set(target.split(" "));

    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const sourceByPage = new Map(
      pages.map((page) => [page.pageNumber, page.textSource])
    );
    const canonicalBlocks = blocks.filter((block) =>
      sourceByPage.get(block.pageNumber) === "pdf"
        ? block.source === "pdf"
        : block.source !== "pdf"
    );

    // Best block: prefer OCR lines fully contained in the quote (longest
    // first); fall back to highest token overlap.
    let best: (typeof blocks)[0] | null = null;
    let bestScore = 0;
    for (const block of canonicalBlocks) {
      if (!block.bbox) continue;
      const blockNorm = norm(block.text);
      if (!blockNorm) continue;
      let score: number;
      if (target.includes(blockNorm) || blockNorm.includes(target)) {
        score = 1000 + Math.min(blockNorm.length, target.length);
      } else {
        const tokens = blockNorm.split(" ");
        const hits = tokens.filter((t) => targetTokens.has(t)).length;
        score = tokens.length >= 3 ? hits / tokens.length : 0;
        if (score < 0.6) score = 0;
        else score *= Math.min(tokens.length, 20);
      }
      if (score > bestScore) {
        bestScore = score;
        best = block;
      }
    }
    if (!best) return null;

    const page = await ctx.db.get(best.pageId);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;
    const fileUrl = await ctx.storage.getUrl(doc.storageId);

    return {
      pageNumber: best.pageNumber,
      bbox: best.bbox ?? null,
      pageWidth: page?.width ?? null,
      pageHeight: page?.height ?? null,
      fileUrl,
      mediaType: doc.mediaType ?? "pdf",
    };
  },
});

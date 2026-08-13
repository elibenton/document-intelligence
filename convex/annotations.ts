import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Highlights and comments the user drew on a document's pages.
 *
 * Geometry arrives already in the page's coordinate space (see the schema
 * comment on `annotations`) — this module never scales anything, so the viewer
 * stays the single owner of the pixels-to-page conversion.
 */

const rectValidator = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
});

const colorValidator = v.union(
  v.literal("yellow"),
  v.literal("green"),
  v.literal("blue"),
  v.literal("pink"),
  v.literal("purple")
);

/** An empty or whitespace-only comment is an absent comment, never a stored "". */
function normalizeComment(comment: string | undefined): string | undefined {
  const trimmed = comment?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Every annotation on the document, in page order. The viewer groups by page
 * and the notes panel groups by section, so one document-wide subscription
 * serves both rather than one per mounted page.
 */
export const byDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("annotations")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    // The index orders by page; within a page, oldest first so the notes list
    // doesn't reshuffle when a comment is edited.
    return rows.sort(
      (a, b) => a.pageNumber - b.pageNumber || a.createdAt - b.createdAt
    );
  },
});

export const create = mutation({
  args: {
    documentId: v.id("documents"),
    pageNumber: v.number(),
    color: colorValidator,
    text: v.string(),
    comment: v.optional(v.string()),
    sectionTitle: v.optional(v.string()),
    rects: v.array(rectValidator),
    blockIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) throw new Error("Document not found");
    if (args.rects.length === 0) {
      throw new Error("An annotation needs at least one rect to anchor to");
    }

    const now = Date.now();
    return await ctx.db.insert("annotations", {
      documentId: args.documentId,
      projectId: document.projectId,
      pageNumber: args.pageNumber,
      color: args.color,
      text: args.text,
      comment: normalizeComment(args.comment),
      sectionTitle: args.sectionTitle,
      rects: args.rects,
      blockIds: args.blockIds,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Recolor and/or (re)write the comment. Both fields are optional so the color
 * swatches and the comment box can each patch the half they own; passing an
 * empty comment clears it back to a bare highlight.
 */
export const update = mutation({
  args: {
    id: v.id("annotations"),
    color: v.optional(colorValidator),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Annotation not found");

    await ctx.db.patch(args.id, {
      ...(args.color ? { color: args.color } : {}),
      ...(args.comment === undefined
        ? {}
        : { comment: normalizeComment(args.comment) }),
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("annotations") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

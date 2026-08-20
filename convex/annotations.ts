import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { authedMutation, authedQuery } from "./authz";
import { requireAnnotation, requireDocument } from "./ownership";

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

function assertValidTimeRange(
  timeRange: { start: number; end: number } | undefined
) {
  if (
    timeRange !== undefined &&
    !(
      Number.isFinite(timeRange.start) &&
      Number.isFinite(timeRange.end) &&
      timeRange.start >= 0 &&
      timeRange.end > timeRange.start
    )
  ) {
    throw new Error("A time range must be a forward span of seconds");
  }
}

/**
 * Every annotation on the document, in page order. The viewer groups by page
 * and the notes panel groups by section, so one document-wide subscription
 * serves both rather than one per mounted page.
 */
export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
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

export const create = authedMutation({
  args: {
    documentId: v.id("documents"),
    pageNumber: v.number(),
    color: colorValidator,
    text: v.string(),
    comment: v.optional(v.string()),
    sectionTitle: v.optional(v.string()),
    rects: v.array(rectValidator),
    blockIds: v.array(v.string()),
    timeRange: v.optional(v.object({ start: v.number(), end: v.number() })),
    quote: v.optional(
      v.object({
        exact: v.string(),
        prefix: v.optional(v.string()),
        suffix: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const document = await requireDocument(ctx, args.documentId);
    // One anchor — geometry, time, or quote — never none. The check keeps
    // the PDF path failing loudly on empty rects while transcript highlights
    // anchor by time and web clip highlights by text quote.
    if (
      args.rects.length === 0 &&
      args.timeRange === undefined &&
      args.quote === undefined
    ) {
      throw new Error(
        "An annotation needs a rect, a time range, or a quote to anchor to"
      );
    }
    assertValidTimeRange(args.timeRange);
    if (args.quote !== undefined && !args.quote.exact.trim()) {
      throw new Error("A quote anchor needs non-empty text");
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
      timeRange: args.timeRange,
      quote: args.quote,
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
export const update = authedMutation({
  args: {
    id: v.id("annotations"),
    color: v.optional(colorValidator),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAnnotation(ctx, args.id);
    await ctx.db.patch(args.id, {
      ...(args.color ? { color: args.color } : {}),
      ...(args.comment === undefined
        ? {}
        : { comment: normalizeComment(args.comment) }),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Fold overlapping highlights into one. The survivor keeps its color and
 * createdAt; absorbed comments are appended to its own so nothing typed is
 * lost. The unioned geometry and text arrive from the viewer, which owns the
 * pixels-to-page conversion — same contract as `create`.
 */
export const merge = authedMutation({
  args: {
    id: v.id("annotations"),
    absorb: v.array(v.id("annotations")),
    text: v.string(),
    rects: v.array(rectValidator),
    blockIds: v.array(v.string()),
    timeRange: v.optional(v.object({ start: v.number(), end: v.number() })),
  },
  handler: async (ctx, args) => {
    const survivor = await requireAnnotation(ctx, args.id);
    if (args.rects.length === 0 && args.timeRange === undefined) {
      throw new Error("An annotation needs a rect or a time range to anchor to");
    }
    assertValidTimeRange(args.timeRange);

    const comments = [survivor.comment];
    for (const id of new Set(args.absorb)) {
      if (id === args.id) {
        throw new Error("A highlight cannot absorb itself");
      }
      const absorbed = await requireAnnotation(ctx, id);
      // Rects are page-local coordinates, so a cross-page merge would leave
      // the survivor's pageNumber describing another page's geometry.
      if (
        absorbed.documentId !== survivor.documentId ||
        absorbed.pageNumber !== survivor.pageNumber
      ) {
        throw new Error("Merged highlights must share a page");
      }
      comments.push(absorbed.comment);
      await ctx.db.delete(id);
    }

    await ctx.db.patch(args.id, {
      text: args.text,
      rects: args.rects,
      blockIds: args.blockIds,
      // Unconditional: the args are the complete new anchor (the XOR above
      // asserts as much), and patching undefined clears a stale range.
      timeRange: args.timeRange,
      comment: normalizeComment(comments.filter(Boolean).join("\n")),
      updatedAt: Date.now(),
    });
    return args.id;
  },
});

export const remove = authedMutation({
  args: { id: v.id("annotations") },
  handler: async (ctx, args) => {
    await requireAnnotation(ctx, args.id);
    await ctx.db.delete(args.id);
  },
});

/**
 * Repair `blockIds` after a re-OCR replaced the document's blocks.
 *
 * The visible highlight needs no repair: `rects` live in the page's own
 * coordinate space and the page image is unchanged by a re-OCR, so it keeps
 * painting where the user drew it. Only the block references go stale —
 * rewritten here as the new blocks whose bbox intersects the stored rects
 * (same coordinate space by construction, see the schema comment). An empty
 * intersection stores [], which quote-anchored clip rows already use.
 * Time- and quote-anchored annotations carry no rects and are skipped.
 */
export const reanchorBlocks = internalMutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const annotations = await ctx.db
      .query("annotations")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const blocksByPage = new Map<
      number,
      { blockId: string; bbox?: { x: number; y: number; width: number; height: number } }[]
    >();
    for (const annotation of annotations) {
      if (annotation.rects.length === 0) continue;
      let pageBlocks = blocksByPage.get(annotation.pageNumber);
      if (!pageBlocks) {
        pageBlocks = await ctx.db
          .query("blocks")
          .withIndex("by_document", (q) =>
            q
              .eq("documentId", args.documentId)
              .eq("pageNumber", annotation.pageNumber)
          )
          .collect();
        blocksByPage.set(annotation.pageNumber, pageBlocks);
      }
      const blockIds = pageBlocks
        .filter((block) => {
          const box = block.bbox;
          if (!box) return false;
          return annotation.rects.some(
            (rect) =>
              rect.x < box.x + box.width &&
              box.x < rect.x + rect.width &&
              rect.y < box.y + box.height &&
              box.y < rect.y + rect.height
          );
        })
        .map((block) => block.blockId);
      const unchanged =
        blockIds.length === annotation.blockIds.length &&
        blockIds.every((id, index) => annotation.blockIds[index] === id);
      if (!unchanged) {
        await ctx.db.patch(annotation._id, {
          blockIds,
          updatedAt: Date.now(),
        });
      }
    }
    return null;
  },
});

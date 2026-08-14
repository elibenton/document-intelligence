import {
  mutation,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { RENDERER_VERSION } from "./rendererConfig";
import { renderEnqueueOptions, renderPool } from "./renderPool";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const bboxValidator = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
});

const nativeBlockValidator = v.object({
  blockId: v.string(),
  text: v.string(),
  bbox: bboxValidator,
  words: v.array(
    v.object({
      text: v.string(),
      bbox: bboxValidator,
    })
  ),
});


// A render action can be killed by the platform (container eviction, the
// 10-minute action limit) without its catch block ever running, which leaves
// renderStatus stuck on "rendering" with no renderLastError and no successor
// scheduled — the viewer then shows "Preparing pages" forever.
//
// renderPool is the primary recovery: its recovery scan reads the platform
// scheduler and retries work the action itself never got to report on. This
// watchdog is the backstop underneath it, for the case the pool cannot see —
// a document left "rendering" with no live work item at all. It only ever
// reports; retrying belongs to the pool, so the two never form competing
// ladders. Every commitPage refreshes renderScheduledAt as the heartbeat.

/**
 * Existing derivatives and their versions, used to make upgrades resumable.
 * Read from `pages.geometryVersion`, which commitPage writes — this used to
 * read the `pageImages` table, which held rasters that are no longer produced.
 */
export const renderedPageVersions = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    return rows.map((row) => ({
      pageNumber: row.pageNumber,
      rendererVersion: row.geometryVersion ?? 0,
    }));
  },
});

/** Document row for the Node renderer (it cannot use ctx.db directly). */
export const docForRender = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => await ctx.db.get(args.documentId),
});

export const beginRender = internalMutation({
  args: {
    documentId: v.id("documents"),
    expectedPages: v.number(),
    rendererVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;
    const isNewAttempt =
      doc.renderStatus !== "rendering" ||
      doc.rendererVersion !== args.rendererVersion;
    await ctx.db.patch(args.documentId, {
      renderStatus: "rendering",
      renderExpectedPages: args.expectedPages,
      rendererVersion: args.rendererVersion,
      renderLastError: undefined,
      renderCompletedAt: undefined,
      renderStartedAt: isNewAttempt ? Date.now() : doc.renderStartedAt,
      renderScheduledAt: Date.now(),
      renderAttempts: isNewAttempt
        ? (doc.renderAttempts ?? 0) + 1
        : doc.renderAttempts,
    });
    // No watchdog. renderPool retries a killed action and then reports the
    // verdict once through renderJobComplete — a second timer could only ever
    // duplicate that, and this one re-armed itself for as long as pages kept
    // committing.
    return null;
  },
});

/**
 * Atomically commits one page's derivative version and, when present, its
 * native PDF text geometry. OCR rows are retained for citation history but
 * viewer queries select only the page's canonical source.
 */

export const commitPage = internalMutation({
  args: {
    documentId: v.id("documents"),
    pageNumber: v.number(),
    width: v.number(),
    height: v.number(),
    rendererVersion: v.number(),
    nativeBlocks: v.array(nativeBlockValidator),
    nativeTextVisibility: v.union(
      v.literal("visible"),
      v.literal("hidden"),
      v.literal("mixed"),
      v.literal("none")
    ),
    nativeGeometryScore: v.number(),
  },
  handler: async (ctx, args) => {
    // Denormalized onto any page row created here (see schema.ts pages.projectId).
    const projectId = (await ctx.db.get(args.documentId))?.projectId;
    const existingPages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) =>
        q
          .eq("documentId", args.documentId)
          .eq("pageNumber", args.pageNumber)
      )
      .collect();
    const canonicalPage = existingPages[0];
    const existingBlocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) =>
        q
          .eq("documentId", args.documentId)
          .eq("pageNumber", args.pageNumber)
      )
      .collect();
    const hasUsableOcr = existingBlocks.some(
      (block) =>
        block.source !== "pdf" &&
        Boolean(
          block.bbox || block.words?.some((word) => Boolean(word.bbox))
        )
    );
    const nativeIsSuspect =
      args.nativeTextVisibility === "hidden" ||
      args.nativeGeometryScore < 0.65;
    const preferOcr = hasUsableOcr && nativeIsSuspect;
    const ocrText = existingBlocks
      .filter((block) => block.source !== "pdf")
      .map((block) => block.text)
      .join("\n");

    let pageId = canonicalPage?._id;
    if (args.nativeBlocks.length > 0 && !preferOcr) {
      const nativeText = args.nativeBlocks.map((block) => block.text).join(" ");
      pageId = canonicalPage
        ? canonicalPage._id
        : await ctx.db.insert("pages", {
            documentId: args.documentId,
            projectId,
            pageNumber: args.pageNumber,
            text: nativeText,
            width: args.width,
            height: args.height,
            textSource: "pdf",
            nativeTextVisibility: args.nativeTextVisibility,
            nativeGeometryScore: args.nativeGeometryScore,
            geometryVersion: args.rendererVersion,
          });
      if (canonicalPage) {
        await ctx.db.patch(pageId, {
          text: nativeText,
          width: args.width,
          height: args.height,
          textSource: "pdf",
          nativeTextVisibility: args.nativeTextVisibility,
          nativeGeometryScore: args.nativeGeometryScore,
          geometryVersion: args.rendererVersion,
          embedding: undefined,
        });
      }
    } else if (canonicalPage) {
      await ctx.db.patch(canonicalPage._id, {
        ...(hasUsableOcr
          ? { text: ocrText, textSource: "ocr" as const, embedding: undefined }
          : {}),
        width: args.width,
        height: args.height,
        nativeTextVisibility: args.nativeTextVisibility,
        nativeGeometryScore: args.nativeGeometryScore,
        geometryVersion: args.rendererVersion,
      });
    }

    if (args.nativeBlocks.length > 0) {
      if (!pageId) {
        pageId = await ctx.db.insert("pages", {
          documentId: args.documentId,
          projectId,
          pageNumber: args.pageNumber,
          text: args.nativeBlocks.map((block) => block.text).join(" "),
          width: args.width,
          height: args.height,
          textSource: "pdf",
          nativeTextVisibility: args.nativeTextVisibility,
          nativeGeometryScore: args.nativeGeometryScore,
          geometryVersion: args.rendererVersion,
        });
      }

      const existingPdfById = new Map(
        existingBlocks
          .filter((block) => block.source === "pdf")
          .map((block) => [block.blockId, block])
      );

      for (const block of args.nativeBlocks) {
        const value = {
          documentId: args.documentId,
          pageId,
          pageNumber: args.pageNumber,
          blockId: block.blockId,
          blockType: "Text",
          text: block.text,
          bbox: block.bbox,
          words: block.words,
          source: "pdf" as const,
        };
        const existing = existingPdfById.get(block.blockId);
        if (existing) await ctx.db.replace(existing._id, value);
        else await ctx.db.insert("blocks", value);
        existingPdfById.delete(block.blockId);
      }
      for (const obsolete of existingPdfById.values()) {
        await ctx.db.delete(obsolete._id);
      }
    } else {
      for (const obsolete of existingBlocks) {
        if (obsolete.source === "pdf") await ctx.db.delete(obsolete._id);
      }
    }
    for (const duplicatePage of existingPages.slice(1)) {
      await ctx.db.delete(duplicatePage._id);
    }

    // Progress is the number of pages whose geometry is at the current
    // version. It used to count pageImages rows, which no longer exist for
    // documents processed after the rasterizer was removed.
    const geometryRows = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const renderedPageCount = geometryRows.filter(
      (row) => row.geometryVersion === args.rendererVersion
    ).length;
    await ctx.db.patch(args.documentId, {
      renderedPageCount,
      renderScheduledAt: Date.now(),
    });
    return null;
  },
});

export const completeRender = internalMutation({
  args: {
    documentId: v.id("documents"),
    expectedPages: v.number(),
    rendererVersion: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, {
      renderStatus: "complete",
      renderExpectedPages: args.expectedPages,
      renderedPageCount: args.expectedPages,
      rendererVersion: args.rendererVersion,
      renderCompletedAt: Date.now(),
      renderLastError: undefined,
      renderScheduledAt: undefined,
    });
    return null;
  },
});

async function markRenderFailed(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  rendererVersion: number,
  error: string
) {
  const doc = await ctx.db.get(documentId);
  if (!doc || doc.rendererVersion !== rendererVersion) return;
  if (doc.renderStatus === "complete") return;
  await ctx.db.patch(documentId, {
    renderStatus: "failed",
    renderLastError: error.slice(0, 1000),
    renderScheduledAt: undefined,
  });
}

export const failRender = internalMutation({
  args: {
    documentId: v.id("documents"),
    rendererVersion: v.number(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    await markRenderFailed(
      ctx,
      args.documentId,
      args.rendererVersion,
      args.error
    );
    return null;
  },
});

/**
 * The single writer of the terminal render state. The pool calls this once the
 * work item is genuinely done — success, exhausted retries, or cancellation —
 * so an individual attempt's death never shows the user a failure the pool is
 * about to recover from.
 */
export const renderJobComplete = internalMutation({
  args: vOnCompleteArgs(
    v.object({
      documentId: v.id("documents"),
      rendererVersion: v.number(),
    })
  ),
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.result.kind === "success") return null;
    const error =
      args.result.kind === "canceled"
        ? "Page rendering was canceled."
        : `Page rendering failed after every retry: ${args.result.error}`;
    await markRenderFailed(
      ctx,
      args.context.documentId,
      args.context.rendererVersion,
      error
    );
    return null;
  },
});

async function scheduleRender(
  ctx: MutationCtx,
  documentId: Id<"documents">
) {
  await ctx.db.patch(documentId, {
    renderStatus: "queued",
    rendererVersion: RENDERER_VERSION,
    renderLastError: undefined,
    renderScheduledAt: Date.now(),
  });
  await renderPool.enqueueAction(
    ctx,
    internal.renderPages.renderBatch,
    { documentId, startPage: 0 },
    renderEnqueueOptions(documentId)
  );
}

/** Ensure missing or outdated page derivatives are scheduled exactly once. */
export const ensureRendered = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;
    const isPaged =
      doc.mimeType === "application/pdf" ||
      doc.mediaType === "pdf" ||
      doc.mediaType === "docx";
    if (!isPaged) return null;

    if (
      doc.renderStatus === "complete" &&
      doc.rendererVersion === RENDERER_VERSION &&
      doc.renderExpectedPages === doc.renderedPageCount
    ) {
      return null;
    }
    if (
      (doc.renderStatus === "queued" || doc.renderStatus === "rendering") &&
      doc.rendererVersion === RENDERER_VERSION &&
      doc.renderScheduledAt &&
      Date.now() - doc.renderScheduledAt < 15 * 60 * 1000
    ) {
      return null;
    }
    await scheduleRender(ctx, args.documentId);
    return null;
  },
});

/** User-visible retry for a failed or stalled render. Existing work is reused. */
export const retryRender = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;
    const isPaged =
      doc.mimeType === "application/pdf" ||
      doc.mediaType === "pdf" ||
      doc.mediaType === "docx";
    if (!isPaged) return null;
    // An explicit retry gets a fresh watchdog attempt budget.
    await ctx.db.patch(args.documentId, { renderAttempts: 0 });
    await scheduleRender(ctx, args.documentId);
    return null;
  },
});

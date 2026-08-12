import {
  query,
  mutation,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { RENDERER_VERSION } from "./rendererConfig";
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

const GEOMETRY_BACKFILL_KEY = "page-text-geometry";
const BACKFILL_BATCH_SIZE = 8;

/** Signed, versioned page derivatives ordered by PDF page number. */
export const byDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pageImages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    return await Promise.all(
      rows.map(async (row) => ({
        pageNumber: row.pageNumber,
        width: row.width,
        height: row.height,
        rendererVersion: row.rendererVersion,
        url: await ctx.storage.getUrl(row.storageId),
      }))
    );
  },
});

/** One signed page derivative for lightweight quote/citation previews. */
export const byPage = query({
  args: { documentId: v.id("documents"), pageNumber: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("pageImages")
      .withIndex("by_document", (q) =>
        q
          .eq("documentId", args.documentId)
          .eq("pageNumber", args.pageNumber)
      )
      .unique();
    if (!row) return null;
    const [document, page] = await Promise.all([
      ctx.db.get(args.documentId),
      ctx.db
        .query("pages")
        .withIndex("by_document", (q) =>
          q
            .eq("documentId", args.documentId)
            .eq("pageNumber", args.pageNumber)
        )
        .unique(),
    ]);
    return {
      url: await ctx.storage.getUrl(row.storageId),
      width: row.width,
      height: row.height,
      rotation: ((
        (document?.viewerRotation ?? 0) +
        (page?.viewerRotationAdjustment ?? 0)
      ) % 360) as 0 | 90 | 180 | 270,
    };
  },
});

/** Existing derivatives and their versions, used to make upgrades resumable. */
export const renderedPageVersions = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pageImages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    return rows.map((row) => ({
      pageNumber: row.pageNumber,
      rendererVersion: row.rendererVersion ?? 0,
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
      renderAttempts: isNewAttempt
        ? (doc.renderAttempts ?? 0) + 1
        : doc.renderAttempts,
    });
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
    storageId: v.optional(v.id("_storage")),
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
    const existingImage = await ctx.db
      .query("pageImages")
      .withIndex("by_document", (q) =>
        q
          .eq("documentId", args.documentId)
          .eq("pageNumber", args.pageNumber)
      )
      .unique();

    if (existingImage) {
      if (args.storageId) await ctx.storage.delete(args.storageId);
      await ctx.db.patch(existingImage._id, {
        width: args.width,
        height: args.height,
        rendererVersion: args.rendererVersion,
      });
    } else {
      if (!args.storageId) throw new Error("A new page derivative needs storage");
      await ctx.db.insert("pageImages", {
        documentId: args.documentId,
        pageNumber: args.pageNumber,
        storageId: args.storageId,
        width: args.width,
        height: args.height,
        rendererVersion: args.rendererVersion,
      });
    }

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

    const currentVersionRows = await ctx.db
      .query("pageImages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const renderedPageCount = currentVersionRows.filter(
      (row) => row.rendererVersion === args.rendererVersion
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

export const failRender = internalMutation({
  args: {
    documentId: v.id("documents"),
    rendererVersion: v.number(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.rendererVersion !== args.rendererVersion) return null;
    await ctx.db.patch(args.documentId, {
      renderStatus: "failed",
      renderLastError: args.error.slice(0, 1000),
      renderScheduledAt: undefined,
    });
    return null;
  },
});

/** Remove all rasters. Reserved for explicit renderer repair operations. */
export const clearRendered = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pageImages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const row of rows) {
      try {
        await ctx.storage.delete(row.storageId);
      } catch {
        // The storage object was already removed.
      }
      await ctx.db.delete(row._id);
    }
    await ctx.db.patch(args.documentId, {
      renderStatus: "queued",
      renderedPageCount: 0,
      renderScheduledAt: undefined,
    });
    return rows.length;
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
  await ctx.scheduler.runAfter(0, internal.renderPages.renderBatch, {
    documentId,
    startPage: 0,
  });
}

/** Progress for the archive-wide renderer/geometry upgrade. */
export const geometryBackfillStatus = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      rendererVersion: v.number(),
      status: v.union(v.literal("running"), v.literal("complete")),
      scanned: v.number(),
      scheduled: v.number(),
      startedAt: v.number(),
      updatedAt: v.number(),
      completedAt: v.optional(v.number()),
    })
  ),
  handler: async (ctx) => {
    const row = await ctx.db
      .query("rendererBackfills")
      .withIndex("by_key", (q) => q.eq("key", GEOMETRY_BACKFILL_KEY))
      .unique();
    if (!row) return null;
    return {
      rendererVersion: row.rendererVersion,
      status: row.status,
      scanned: row.scanned,
      scheduled: row.scheduled,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
    };
  },
});

/** Start or restart the resumable renderer backfill at the current version. */
export const startGeometryBackfill = mutation({
  args: {},
  returns: v.object({ started: v.boolean() }),
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("rendererBackfills")
      .withIndex("by_key", (q) => q.eq("key", GEOMETRY_BACKFILL_KEY))
      .unique();
    if (
      existing?.status === "running" &&
      existing.rendererVersion === RENDERER_VERSION
    ) {
      return { started: false };
    }

    const now = Date.now();
    const value = {
      key: GEOMETRY_BACKFILL_KEY,
      rendererVersion: RENDERER_VERSION,
      status: "running" as const,
      cursor: undefined,
      scanned: 0,
      scheduled: 0,
      startedAt: now,
      updatedAt: now,
      completedAt: undefined,
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("rendererBackfills", value);

    await ctx.scheduler.runAfter(0, internal.pageImages.backfillGeometryBatch, {
      cursor: null,
      rendererVersion: RENDERER_VERSION,
    });
    return { started: true };
  },
});

/** Scan a bounded archive slice and continue from Convex's stable cursor. */
export const backfillGeometryBatch = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    rendererVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("rendererBackfills")
      .withIndex("by_key", (q) => q.eq("key", GEOMETRY_BACKFILL_KEY))
      .unique();
    if (
      !state ||
      state.status !== "running" ||
      state.rendererVersion !== args.rendererVersion ||
      args.rendererVersion !== RENDERER_VERSION
    ) {
      return null;
    }

    const page = await ctx.db
      .query("documents")
      .withIndex("by_uploadedAt")
      .order("asc")
      .paginate({ numItems: BACKFILL_BATCH_SIZE, cursor: args.cursor });
    let scheduled = 0;
    const now = Date.now();
    for (const doc of page.page) {
      const isPdf = doc.mimeType === "application/pdf" || doc.mediaType === "pdf";
      const isCurrent =
        doc.renderStatus === "complete" &&
        doc.rendererVersion === RENDERER_VERSION &&
        doc.renderExpectedPages === doc.renderedPageCount;
      const isFreshlyInFlight =
        (doc.renderStatus === "queued" || doc.renderStatus === "rendering") &&
        doc.rendererVersion === RENDERER_VERSION &&
        doc.renderScheduledAt !== undefined &&
        now - doc.renderScheduledAt < 15 * 60 * 1000;
      if (isPdf && !isCurrent && !isFreshlyInFlight) {
        await scheduleRender(ctx, doc._id);
        scheduled++;
      }
    }

    const nextScanned = state.scanned + page.page.length;
    const nextScheduled = state.scheduled + scheduled;
    if (page.isDone) {
      await ctx.db.patch(state._id, {
        status: "complete",
        cursor: undefined,
        scanned: nextScanned,
        scheduled: nextScheduled,
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }

    await ctx.db.patch(state._id, {
      cursor: page.continueCursor,
      scanned: nextScanned,
      scheduled: nextScheduled,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      250,
      internal.pageImages.backfillGeometryBatch,
      {
        cursor: page.continueCursor,
        rendererVersion: args.rendererVersion,
      }
    );
    return null;
  },
});

/** Ensure missing or outdated page derivatives are scheduled exactly once. */
export const ensureRendered = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;
    const isPdf = doc.mimeType === "application/pdf" || doc.mediaType === "pdf";
    if (!isPdf) return null;

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
    const isPdf = doc.mimeType === "application/pdf" || doc.mediaType === "pdf";
    if (!isPdf) return null;
    await scheduleRender(ctx, args.documentId);
    return null;
  },
});

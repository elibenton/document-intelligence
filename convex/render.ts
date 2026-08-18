import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { RENDERER_VERSION } from "./rendererConfig";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authedMutation } from "./authz";
import { documentIssueContext, recordIssue } from "./issues";
import { requireDocument } from "./ownership";

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
// action time limit) without its catch block ever running, which leaves
// renderStatus stuck on "rendering" with no renderLastError and no successor
// scheduled — the viewer would show "Preparing pages" forever.
//
// Recovery is view-triggered: ensureRendered treats a render whose
// renderScheduledAt heartbeat is stale as dead and re-schedules it, and
// rendering is resumable (commits are versioned per page), so a re-kick only
// redoes what the dead action never finished. Every commitPage refreshes
// renderScheduledAt as the heartbeat.

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
    // No watchdog timer here: ensureRendered re-kicks a render whose
    // heartbeat has gone stale, and rendering is resumable, so a killed
    // action costs only the pages it never committed.
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

    // Heartbeat only. `renderedPageCount` is deliberately not maintained here:
    // its sole reader is ensureRendered's guard, which consults it only when
    // renderStatus is already "complete" — the state completeRender writes it
    // in. Every value a per-page recount produced was overwritten there, so
    // scanning every page row of the document on every page cost a
    // whole-document read set (page rows carry a 1536-float embedding) to
    // maintain a number nobody read. That read set is what collided with
    // ingest.ingestParseResults, which replaces the same page range while
    // rendering is still running.
    await ctx.db.patch(args.documentId, { renderScheduledAt: Date.now() });
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

  // Its own surface rather than "pipeline": a render failure leaves a document
  // that parsed, searched and extracted perfectly and simply cannot be looked
  // at. Grouped with parse failures it would read as the same problem, and it
  // is the one most likely to be reported as "the app is broken".
  await recordIssue(ctx, {
    surface: "render",
    stage: "render",
    message: error,
    documentId,
    ...(await documentIssueContext(ctx, documentId)),
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

/** Ensure missing or outdated page derivatives are scheduled exactly once. */
export const ensureRendered = authedMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await requireDocument(ctx, args.documentId);
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
export const retryRender = authedMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await requireDocument(ctx, args.documentId);
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

/**
 * Native PDF text layer — the browser-committed alternative to vision OCR.
 *
 * The schema has carried per-page source selection (`pages.textSource`,
 * `blocks.source`) and the read/merge sides for a while: `blocks.byDocument*`
 * filter by source, and `ingest.reconcilePagesAndBlocks` refuses to let a
 * later OCR result overwrite preferred native pages. This module is the
 * producer: the upload flow extracts a digital-native PDF's own text layer
 * with pdf.js (src/lib/pdfNativeText.ts) and commits it here in batches,
 * before the parse stage is enqueued.
 *
 * When the committed layer is complete — every page visible native text or
 * genuinely blank, geometry above the shared floor — `runPipeline` skips the
 * file-in understanding call and the OCR task entirely and analyzes the
 * stored text instead (`completeNativePages` is that gate). Anything less
 * falls back to today's OCR path untouched.
 */

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { authedMutation } from "./authz";
import { requireDocument } from "./ownership";
import { enqueueStage } from "./processing";
import { enforceDemoPageLimit } from "./demo";
import { geometryForPage, NATIVE_GEOMETRY_MIN_SCORE } from "./ingest";
import { sanitizeTableOfContents } from "./metadata";
import { cleanPdfAuthor, cleanPdfDate, cleanPdfTitle } from "./pdfNativeMetadata";
import { applyDisplayName, normalizeTitle } from "./rename";

const bboxValidator = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
});

const nativePageValidator = v.object({
  pageNumber: v.number(),
  text: v.string(),
  width: v.number(),
  height: v.number(),
  visibility: v.union(v.literal("visible"), v.literal("none")),
  geometryScore: v.number(),
  blocks: v.array(
    v.object({
      blockId: v.string(),
      text: v.string(),
      bbox: v.optional(bboxValidator),
      words: v.optional(
        v.array(
          v.object({
            text: v.string(),
            bbox: v.optional(bboxValidator),
          })
        )
      ),
    })
  ),
});

/**
 * Commit one batch of native pages. Only meaningful between upload and the
 * parse stage — once processing has begun the batch is dropped rather than
 * raced against the pipeline's own writes. Idempotent per page: a retried
 * batch replaces what the first attempt stored.
 */
export const ingestNativePages = authedMutation({
  args: {
    documentId: v.id("documents"),
    pageCount: v.number(),
    pages: v.array(nativePageValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await requireDocument(ctx, args.documentId);
    if (document.mediaType !== "pdf" || document.status !== "uploaded") {
      return null;
    }
    if (
      !Number.isInteger(args.pageCount) ||
      args.pageCount < 1 ||
      args.pageCount > 10_000
    ) {
      throw new Error("Invalid native page count");
    }

    if (document.pageCount === undefined) {
      await ctx.db.patch(args.documentId, { pageCount: args.pageCount });
      // Same gate ingestParseResults applies at the same moment — the first
      // write of the true page count. A failed demo document stores no pages.
      if (await enforceDemoPageLimit(ctx, args.documentId, args.pageCount)) {
        return null;
      }
    }

    for (const page of args.pages) {
      if (
        !Number.isInteger(page.pageNumber) ||
        page.pageNumber < 0 ||
        page.pageNumber >= args.pageCount
      ) {
        throw new Error(`Native page ${page.pageNumber} is out of range`);
      }
      const existingPages = await ctx.db
        .query("pages")
        .withIndex("by_document", (q) =>
          q.eq("documentId", args.documentId).eq("pageNumber", page.pageNumber)
        )
        .collect();
      const pageValue = {
        documentId: args.documentId,
        projectId: document.projectId,
        pageNumber: page.pageNumber,
        text: page.text.trim(),
        width: page.width,
        height: page.height,
        textSource: "pdf" as const,
        nativeTextVisibility: page.visibility,
        nativeGeometryScore: Math.max(0, Math.min(1, page.geometryScore)),
      };
      const canonicalPage = existingPages[0];
      const pageId = canonicalPage
        ? canonicalPage._id
        : await ctx.db.insert("pages", pageValue);
      if (canonicalPage) await ctx.db.replace("pages", pageId, pageValue);
      for (const duplicate of existingPages.slice(1)) {
        await ctx.db.delete(duplicate._id);
      }

      const existingBlocks = await ctx.db
        .query("blocks")
        .withIndex("by_document", (q) =>
          q.eq("documentId", args.documentId).eq("pageNumber", page.pageNumber)
        )
        .collect();
      for (const block of existingBlocks) {
        if (block.source === "pdf") await ctx.db.delete(block._id);
      }
      for (const block of page.blocks) {
        const geometry = geometryForPage(
          block.bbox,
          block.words,
          page.width,
          page.height
        );
        await ctx.db.insert("blocks", {
          documentId: args.documentId,
          pageId,
          pageNumber: page.pageNumber,
          blockId: block.blockId,
          blockType: "Line",
          text: block.text,
          source: "pdf",
          bbox: geometry.bbox,
          words: geometry.words,
        });
      }
    }
    return null;
  },
});

/**
 * The upload's native commit is over (complete, partial, or empty) — record
 * what the PDF file itself declares (Info title/author, the outline), then
 * start the parse stage that createDocument deferred. The scheduler failsafe
 * (processing.ensureParseStarted) covers a browser that never gets here.
 *
 * The declared metadata is ground truth the model is then not asked to
 * re-derive: understandingRequest (processingStages.ts) omits the covered
 * fields from the Analyze schema, and saveMetadataResult reads these values
 * back in. The outline and title also land on the document immediately, so
 * the Contents tab and the library title exist before any provider call
 * returns.
 */
export const finishNativeIngest = authedMutation({
  args: {
    documentId: v.id("documents"),
    metadata: v.optional(
      v.object({
        title: v.optional(v.string()),
        author: v.optional(v.string()),
        creationDate: v.optional(v.string()),
        tableOfContents: v.optional(
          v.array(
            v.object({
              title: v.string(),
              level: v.number(),
              page: v.number(),
            })
          )
        ),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await requireDocument(ctx, args.documentId);
    if (document.status !== "uploaded") return null;

    const title = cleanPdfTitle(args.metadata?.title, document.name);
    const author = cleanPdfAuthor(args.metadata?.author);
    const createdDate = cleanPdfDate(args.metadata?.creationDate, Date.now());
    // Page mode always sets `page`; the `?? 1` only narrows the type back to
    // the page-required shape sourceMetadata declares.
    const tableOfContents = sanitizeTableOfContents(
      args.metadata?.tableOfContents,
      document.pageCount
    ).map((entry) => ({
      title: entry.title,
      level: entry.level,
      page: entry.page ?? 1,
    }));
    if (title || author || createdDate || tableOfContents.length > 0) {
      await ctx.db.patch(args.documentId, {
        sourceMetadata: {
          title,
          author,
          tableOfContents:
            tableOfContents.length > 0 ? tableOfContents : undefined,
          createdDate: createdDate ?? undefined,
        },
        ...(tableOfContents.length > 0 ? { tableOfContents } : {}),
        ...(createdDate
          ? {
              createdDate: createdDate.value,
              createdDatePrecision: createdDate.precision,
              createdDateSource: "native",
            }
          : {}),
        ...(author ? { author, authorSource: "native" } : {}),
      });
      if (title) {
        const displayTitle = normalizeTitle(title);
        if (displayTitle) {
          await applyDisplayName(ctx, args.documentId, displayTitle, "native");
        }
      }
    }

    await enqueueStage(ctx, args.documentId, "parse");
    return null;
  },
});

/**
 * The pipeline's fast-path gate: the document's stored native pages when —
 * and only when — they cover every page with trustworthy text, in order.
 * A page qualifies as visible native text with geometry above the shared
 * floor, or as a genuinely blank page (no text, no image). One page short
 * and the answer is null: vision OCR is still needed, so the normal path
 * runs and the per-page merge in ingest.ts decides what survives.
 */
export const completeNativePages = internalQuery({
  args: { documentId: v.id("documents") },
  returns: v.union(
    v.null(),
    v.array(v.object({ pageNumber: v.number(), text: v.string() }))
  ),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    const pageCount = document?.pageCount;
    if (!pageCount) return null;
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const native = pages
      .filter((page) => page.textSource === "pdf")
      .sort((a, b) => a.pageNumber - b.pageNumber);
    if (native.length !== pageCount) return null;
    const complete = native.every(
      (page, index) =>
        page.pageNumber === index &&
        (page.nativeGeometryScore ?? 0) >= NATIVE_GEOMETRY_MIN_SCORE &&
        (page.nativeTextVisibility === "visible"
          ? page.text.trim().length > 0
          : page.nativeTextVisibility === "none" && !page.text.trim())
    );
    if (!complete || !native.some((page) => page.text.trim())) return null;
    return native.map((page) => ({
      pageNumber: page.pageNumber,
      text: page.text,
    }));
  },
});

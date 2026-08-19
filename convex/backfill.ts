import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { sanitizeNativeDate } from "./nativeDate";
import { cleanPdfAuthor } from "./pdfNativeMetadata";
import { extractHtmlMeta, type HtmlMeta } from "./htmlMeta";

// ---------------------------------------------------------------------------
// Source-native metadata backfill — corpus migrations, not pipeline stages:
// no job rows, no progress UI, idempotent and re-runnable, so a killed run is
// resumed by re-running the command. Zero Interfaze calls except the clip
// re-analysis, which is the point of the clip pass.
//
// Run order (see also migrations:backfillSourceMetadataFromPdf):
//   npx convex run migrations:backfillSourceMetadataFromPdf
//   npx convex run backfill:reclipFromArchive
//   npx convex run backfillNode:backfillNativeMetadata
// ---------------------------------------------------------------------------

const PAGE_SIZE = 5;

/** One page of documents, for the actions to filter. Minimal fields. */
export const pageDocuments = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({
    documents: v.array(
      v.object({
        _id: v.id("documents"),
        mediaType: v.optional(v.string()),
        storageId: v.id("_storage"),
        sizeBytes: v.optional(v.number()),
        durationSeconds: v.optional(v.number()),
        createdDate: v.optional(v.string()),
        createdDateSource: v.optional(v.string()),
        hasSourceCreatedDate: v.boolean(),
      })
    ),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("documents")
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE });
    return {
      documents: page.page.map((doc) => ({
        _id: doc._id,
        mediaType: doc.mediaType,
        storageId: doc.storageId,
        sizeBytes: doc.sizeBytes,
        durationSeconds: doc.durationSeconds,
        createdDate: doc.createdDate,
        createdDateSource: doc.createdDateSource,
        hasSourceCreatedDate: doc.sourceMetadata?.createdDate !== undefined,
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Commit one document's file-derived facts. Re-sanitizes everything the
 * action read; the columns honor stamps (a "native"/"human" value or a human
 * tombstone is inviolate), and sourceMetadata only gains what it lacks.
 */
export const commitNativeBackfill = internalMutation({
  args: {
    documentId: v.id("documents"),
    createdDate: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) return null;
    const createdDate = sanitizeNativeDate(args.createdDate, Date.now());
    const dateOpen =
      document.createdDateSource === undefined ||
      document.createdDateSource === "ai";
    const duration =
      typeof args.durationSeconds === "number" &&
      Number.isFinite(args.durationSeconds) &&
      args.durationSeconds > 0
        ? Math.round(args.durationSeconds * 10) / 10
        : undefined;
    await ctx.db.patch(args.documentId, {
      ...(createdDate && dateOpen
        ? {
            createdDate: createdDate.value,
            createdDatePrecision: createdDate.precision,
            createdDateSource: "native",
          }
        : {}),
      ...(createdDate && !document.sourceMetadata?.createdDate
        ? { sourceMetadata: { ...document.sourceMetadata, createdDate } }
        : {}),
      ...(duration !== undefined && document.durationSeconds === undefined
        ? { durationSeconds: duration }
        : {}),
    });
    return null;
  },
});

const htmlMetaValidator = v.object({
  title: v.optional(v.string()),
  byline: v.optional(v.string()),
  siteName: v.optional(v.string()),
  description: v.optional(v.string()),
  publishedAt: v.optional(v.string()),
  lang: v.optional(v.string()),
  ogImage: v.optional(v.string()),
});

/**
 * Re-run one clip from its archived page, REPLACING the old metadata
 * wholesale — deliberately ignoring stamps: everything the old blob rewrite
 * produced is known-corrupted (the first Analyze run destroyed the ingest
 * facts), so this rebuilds the row as if the clip had just arrived and
 * schedules a fresh Analyze. The user's clip notes are the one thing carried
 * over — they never came from the page.
 */
export const recommitClipFromArchive = internalMutation({
  args: { documentId: v.id("documents"), meta: htmlMetaValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document || document.mediaType !== "webScrape") return null;
    const meta = args.meta;

    const createdDate = sanitizeNativeDate(meta.publishedAt, Date.now());
    const author = cleanPdfAuthor(meta.byline);
    let notes: string | undefined;
    try {
      const old = JSON.parse(document.metadata ?? "{}") as {
        additional?: Array<{ key?: string; value?: string }>;
      };
      notes = old.additional?.find((entry) => entry.key === "notes")?.value;
    } catch {
      /* corrupted blob — nothing to carry over */
    }

    await ctx.db.patch(args.documentId, {
      createdDate: createdDate?.value,
      createdDatePrecision: createdDate?.precision,
      createdDateSource: createdDate ? "native" : undefined,
      author,
      authorSource: author ? "native" : undefined,
      sourceMetadata: {
        title: meta.title?.trim() || undefined,
        author,
        createdDate: createdDate ?? undefined,
        siteName: meta.siteName?.trim() || undefined,
        description: meta.description?.trim() || undefined,
        ogImage: meta.ogImage?.trim() || undefined,
      },
      metadata: JSON.stringify({
        title: meta.title || document.name,
        summary: meta.description,
        date: meta.publishedAt,
        author: meta.byline,
        language: meta.lang,
        additional: [
          ...(document.sourceUrl
            ? [{ key: "source url", value: document.sourceUrl }]
            : []),
          ...(meta.siteName ? [{ key: "site", value: meta.siteName }] : []),
          ...(meta.ogImage ? [{ key: "og image", value: meta.ogImage }] : []),
          ...(notes ? [{ key: "notes", value: notes }] : []),
        ],
      }),
      metadataSource: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.processingStages.runAnalyze, {
      documentId: args.documentId,
    });
    return null;
  },
});

/**
 * Re-run every clip from its stored archive HTML. The archive still carries
 * the page's original og:/article:/JSON-LD tags, so the extraction the
 * extension does live is repeated over the stored bytes (htmlMeta.ts), then
 * recommitClipFromArchive replaces the row's metadata and re-analyzes.
 *
 *   npx convex run backfill:reclipFromArchive
 */
export const reclipFromArchive = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.runQuery(internal.backfill.pageDocuments, {
      cursor: args.cursor ?? null,
    });
    for (const doc of page.documents) {
      if (doc.mediaType !== "webScrape") continue;
      let meta: HtmlMeta;
      try {
        const blob = await ctx.storage.get(doc.storageId);
        if (!blob) continue;
        meta = extractHtmlMeta(await blob.text());
      } catch {
        continue; // unreadable archive — leave the row as it is
      }
      await ctx.runMutation(internal.backfill.recommitClipFromArchive, {
        documentId: doc._id,
        meta,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.backfill.reclipFromArchive, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

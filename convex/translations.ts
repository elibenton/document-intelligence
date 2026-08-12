import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";

const GLOBAL_SETTINGS_KEY = "global";
const MAX_TRANSLATED_PAGES_PER_DOCUMENT = 2_000;

const contextValidator = v.union(
  v.null(),
  v.object({
    sourceLanguageCode: v.optional(v.string()),
    sourceLanguageIsMixed: v.optional(v.boolean()),
    languageCode: v.string(),
    translationVersion: v.number(),
  })
);

export const getContext = internalQuery({
  args: { documentId: v.id("documents") },
  returns: contextValidator,
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) return null;
    const settings = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", GLOBAL_SETTINGS_KEY))
      .unique();
    return {
      sourceLanguageCode: document.sourceLanguageCode,
      sourceLanguageIsMixed: document.sourceLanguageIsMixed,
      languageCode: settings?.defaultLanguageCode ?? "en",
      translationVersion: settings?.translationVersion ?? 1,
    };
  },
});

const pageWorkValidator = v.union(
  v.null(),
  v.object({
    pageId: v.id("pages"),
    pageNumber: v.number(),
    text: v.string(),
    existingText: v.optional(v.string()),
    existingStatus: v.optional(v.string()),
    existingNextOffset: v.optional(v.number()),
    existingSourceFingerprint: v.optional(v.string()),
  })
);

export const getPageWork = internalQuery({
  args: {
    documentId: v.id("documents"),
    targetLanguageCode: v.string(),
    afterPageNumber: v.number(),
    pageNumber: v.optional(v.number()),
  },
  returns: pageWorkValidator,
  handler: async (ctx, args) => {
    const page = args.pageNumber === undefined
      ? await ctx.db
          .query("pages")
          .withIndex("by_document", (q) =>
            q.eq("documentId", args.documentId).gt("pageNumber", args.afterPageNumber)
          )
          .first()
      : await ctx.db
          .query("pages")
          .withIndex("by_document", (q) =>
            q.eq("documentId", args.documentId).eq("pageNumber", args.pageNumber!)
          )
          .unique();
    if (!page) return null;
    const existing = await ctx.db
      .query("pageTranslations")
      .withIndex("by_document_and_target_and_page", (q) =>
        q
          .eq("documentId", args.documentId)
          .eq("targetLanguageCode", args.targetLanguageCode)
          .eq("pageNumber", page.pageNumber)
      )
      .unique();
    return {
      pageId: page._id,
      pageNumber: page.pageNumber,
      text: page.text,
      existingText: existing?.text,
      existingStatus: existing?.status,
      existingNextOffset: existing?.nextOffset,
      existingSourceFingerprint: existing?.sourceFingerprint,
    };
  },
});

export const getTranscriptBatch = internalQuery({
  args: {
    documentId: v.id("documents"),
    afterSegmentIndex: v.number(),
    targetLanguageCode: v.string(),
    translationVersion: v.number(),
  },
  returns: v.object({
    segments: v.array(
      v.object({
        segmentIndex: v.number(),
        text: v.string(),
      })
    ),
    lastScannedSegmentIndex: v.number(),
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_document", (q) =>
        q
          .eq("documentId", args.documentId)
          .gt("segmentIndex", args.afterSegmentIndex)
      )
      .take(30);
    let chars = 0;
    const out: Array<{ segmentIndex: number; text: string }> = [];
    for (const row of rows) {
      if (
        row.translatedLanguageCode === args.targetLanguageCode &&
        row.translationVersion === args.translationVersion
      ) {
        continue;
      }
      if (out.length > 0 && chars + row.text.length > 18_000) break;
      out.push({ segmentIndex: row.segmentIndex, text: row.text });
      chars += row.text.length;
    }
    return {
      segments: out,
      lastScannedSegmentIndex:
        rows.length > 0 ? rows[rows.length - 1].segmentIndex : args.afterSegmentIndex,
      done: rows.length < 30,
    };
  },
});

export const setSourceLanguage = internalMutation({
  args: {
    documentId: v.id("documents"),
    sourceLanguageCode: v.string(),
    sourceLanguageIsMixed: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sourceLanguageCode = args.sourceLanguageCode
      .trim()
      .toLowerCase()
      .replaceAll("_", "-");
    if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(sourceLanguageCode)) {
      await ctx.db.patch(args.documentId, {
        sourceLanguageCode,
        ...(args.sourceLanguageIsMixed === undefined
          ? {}
          : { sourceLanguageIsMixed: args.sourceLanguageIsMixed }),
      });
    }
    return null;
  },
});

async function isCurrent(
  ctx: MutationCtx,
  languageCode: string,
  translationVersion: number
) {
  const settings = await ctx.db
    .query("appSettings")
    .withIndex("by_key", (q) => q.eq("key", GLOBAL_SETTINGS_KEY))
    .unique();
  return (
    (settings?.defaultLanguageCode ?? "en") === languageCode &&
    (settings?.translationVersion ?? 1) === translationVersion
  );
}

export const beginTranslation = internalMutation({
  args: {
    documentId: v.id("documents"),
    languageCode: v.string(),
    translationVersion: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await isCurrent(ctx, args.languageCode, args.translationVersion))) {
      return false;
    }
    const document = await ctx.db.get(args.documentId);
    if (!document) return false;
    await ctx.db.patch(args.documentId, {
      translationLanguageCode: args.languageCode,
      translationStatus: "translating",
      translationError: undefined,
      translationVersion: args.translationVersion,
    });
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", "translate")
      )
      .unique();
    if (job) {
      await ctx.db.patch(job._id, {
        status: "running",
        startedAt: Date.now(),
        completedAt: undefined,
        errorMessage: undefined,
      });
    } else {
      await ctx.db.insert("processingJobs", {
        documentId: args.documentId,
        stage: "translate",
        status: "running",
        startedAt: Date.now(),
      });
    }
    return true;
  },
});

export const queueTranslation = internalMutation({
  args: {
    documentId: v.id("documents"),
    languageCode: v.string(),
    translationVersion: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await isCurrent(ctx, args.languageCode, args.translationVersion))) {
      return false;
    }
    const document = await ctx.db.get(args.documentId);
    if (!document) return false;
    await ctx.db.patch(args.documentId, {
      translationLanguageCode: args.languageCode,
      translationStatus: "queued",
      translationError: undefined,
      translationVersion: args.translationVersion,
    });
    await ctx.scheduler.runAfter(0, internal.translationNode.translateDocument, {
      documentId: args.documentId,
      languageCode: args.languageCode,
      translationVersion: args.translationVersion,
    });
    return true;
  },
});

export const markNotNeeded = internalMutation({
  args: {
    documentId: v.id("documents"),
    languageCode: v.string(),
    translationVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await isCurrent(ctx, args.languageCode, args.translationVersion))) {
      return null;
    }
    await ctx.db.patch(args.documentId, {
      translationLanguageCode: args.languageCode,
      translationStatus: "not_needed",
      translationError: undefined,
      translationVersion: args.translationVersion,
    });
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", "translate")
      )
      .unique();
    if (job) {
      await ctx.db.patch(job._id, { status: "completed", completedAt: Date.now() });
    }
    return null;
  },
});

export const savePageChunk = internalMutation({
  args: {
    documentId: v.id("documents"),
    pageId: v.id("pages"),
    pageNumber: v.number(),
    sourceFingerprint: v.string(),
    sourceLanguageCode: v.string(),
    targetLanguageCode: v.string(),
    translationVersion: v.number(),
    offset: v.number(),
    nextOffset: v.number(),
    translatedText: v.string(),
    complete: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await isCurrent(ctx, args.targetLanguageCode, args.translationVersion))) {
      return false;
    }
    const existing = await ctx.db
      .query("pageTranslations")
      .withIndex("by_document_and_target_and_page", (q) =>
        q
          .eq("documentId", args.documentId)
          .eq("targetLanguageCode", args.targetLanguageCode)
          .eq("pageNumber", args.pageNumber)
      )
      .unique();
    if (
      existing?.sourceFingerprint === args.sourceFingerprint &&
      existing.nextOffset > args.offset
    ) {
      return true;
    }
    const text =
      existing?.sourceFingerprint === args.sourceFingerprint && args.offset > 0
        ? `${existing.text}${
            existing.text &&
            args.translatedText &&
            !/\s$/u.test(existing.text) &&
            !/^\s/u.test(args.translatedText)
              ? "\n"
              : ""
          }${args.translatedText}`
        : args.translatedText;
    const value = {
      documentId: args.documentId,
      pageId: args.pageId,
      pageNumber: args.pageNumber,
      sourceLanguageCode: args.sourceLanguageCode,
      targetLanguageCode: args.targetLanguageCode,
      text,
      sourceFingerprint: args.sourceFingerprint,
      status: args.complete ? ("complete" as const) : ("translating" as const),
      nextOffset: args.nextOffset,
      translationVersion: args.translationVersion,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("pageTranslations", value);
    const document = await ctx.db.get(args.documentId);
    if (document && (!document.sourceLanguageCode || document.sourceLanguageCode === "und")) {
      await ctx.db.patch(args.documentId, { sourceLanguageCode: args.sourceLanguageCode });
    }
    return true;
  },
});

export const activateCachedPage = internalMutation({
  args: {
    documentId: v.id("documents"),
    targetLanguageCode: v.string(),
    translationVersion: v.number(),
    pageNumber: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await isCurrent(ctx, args.targetLanguageCode, args.translationVersion))) {
      return false;
    }
    const existing = await ctx.db
      .query("pageTranslations")
      .withIndex("by_document_and_target_and_page", (q) =>
        q
          .eq("documentId", args.documentId)
          .eq("targetLanguageCode", args.targetLanguageCode)
          .eq("pageNumber", args.pageNumber)
      )
      .unique();
    if (!existing || existing.status !== "complete") return false;
    await ctx.db.patch(existing._id, {
      translationVersion: args.translationVersion,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const saveTranscriptBatch = internalMutation({
  args: {
    documentId: v.id("documents"),
    sourceLanguageCode: v.string(),
    targetLanguageCode: v.string(),
    translationVersion: v.number(),
    translations: v.array(
      v.object({ segmentIndex: v.number(), text: v.string() })
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await isCurrent(ctx, args.targetLanguageCode, args.translationVersion))) {
      return false;
    }
    for (const translation of args.translations) {
      const segment = await ctx.db
        .query("transcriptSegments")
        .withIndex("by_document", (q) =>
          q
            .eq("documentId", args.documentId)
            .eq("segmentIndex", translation.segmentIndex)
        )
        .unique();
      if (!segment) continue;
      await ctx.db.patch(segment._id, {
        translatedText: translation.text,
        translatedLanguageCode: args.targetLanguageCode,
        translationVersion: args.translationVersion,
      });
    }
    const document = await ctx.db.get(args.documentId);
    if (document && (!document.sourceLanguageCode || document.sourceLanguageCode === "und")) {
      await ctx.db.patch(args.documentId, { sourceLanguageCode: args.sourceLanguageCode });
    }
    return true;
  },
});

export const completeTranslation = internalMutation({
  args: {
    documentId: v.id("documents"),
    languageCode: v.string(),
    translationVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await isCurrent(ctx, args.languageCode, args.translationVersion))) {
      return null;
    }
    await ctx.db.patch(args.documentId, {
      translationLanguageCode: args.languageCode,
      translationStatus: "complete",
      translationError: undefined,
      translationVersion: args.translationVersion,
    });
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", "translate")
      )
      .unique();
    if (job) {
      await ctx.db.patch(job._id, {
        status: "completed",
        completedAt: Date.now(),
        errorMessage: undefined,
      });
    }
    return null;
  },
});

export const failTranslation = internalMutation({
  args: {
    documentId: v.id("documents"),
    languageCode: v.string(),
    translationVersion: v.number(),
    errorMessage: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await isCurrent(ctx, args.languageCode, args.translationVersion))) {
      return null;
    }
    const errorMessage = args.errorMessage.slice(0, 500);
    await ctx.db.patch(args.documentId, {
      translationLanguageCode: args.languageCode,
      translationStatus: "failed",
      translationError: errorMessage,
      translationVersion: args.translationVersion,
    });
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", "translate")
      )
      .unique();
    if (job) await ctx.db.patch(job._id, { status: "failed", errorMessage });
    return null;
  },
});

export const pagesByDocument = query({
  args: { documentId: v.id("documents") },
  returns: v.array(
    v.object({
      pageNumber: v.number(),
      text: v.string(),
      targetLanguageCode: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", GLOBAL_SETTINGS_KEY))
      .unique();
    const targetLanguageCode = settings?.defaultLanguageCode ?? "en";
    const rows = await ctx.db
      .query("pageTranslations")
      .withIndex("by_document_and_target_and_page", (q) =>
        q.eq("documentId", args.documentId).eq("targetLanguageCode", targetLanguageCode)
      )
      .take(MAX_TRANSLATED_PAGES_PER_DOCUMENT);
    return rows
      .filter((row) => row.status === "complete")
      .map((row) => ({
        pageNumber: row.pageNumber,
        text: row.text,
        targetLanguageCode: row.targetLanguageCode,
      }));
  },
});

export const retry = mutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", GLOBAL_SETTINGS_KEY))
      .unique();
    const languageCode = settings?.defaultLanguageCode ?? "en";
    const translationVersion = settings?.translationVersion ?? 1;
    await ctx.runMutation(internal.translations.queueTranslation, {
      documentId: args.documentId,
      languageCode,
      translationVersion,
    });
    return null;
  },
});

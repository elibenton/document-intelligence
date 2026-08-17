import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./authz";
import { requireDocument } from "./ownership";
import { languageForDocument, languageForProject } from "./settings";
import { requireBudget } from "./budget";
import { translateUnits } from "./interfaze";
import { usageLogger } from "./apiLogs";

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
    // From the project, not the document, because the document row is already
    // in hand — languageForDocument would re-read it.
    const settings = await languageForProject(ctx, document.projectId);
    return {
      sourceLanguageCode: document.sourceLanguageCode,
      sourceLanguageIsMixed: document.sourceLanguageIsMixed,
      languageCode: settings.defaultLanguageCode,
      translationVersion: settings.translationVersion,
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

/**
 * Is this queued translation still the one its owner wants?
 *
 * Takes the document because the answer is now per-account: work queued under
 * one user's language must not be validated against another's. Every caller
 * already has the id, since translation work is always about one document.
 */
async function isCurrent(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  languageCode: string,
  translationVersion: number
) {
  const settings = await languageForDocument(ctx, documentId);
  return (
    settings.defaultLanguageCode === languageCode &&
    settings.translationVersion === translationVersion
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
    if (!(await isCurrent(ctx, args.documentId, args.languageCode, args.translationVersion))) {
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
    if (!(await isCurrent(ctx, args.documentId, args.languageCode, args.translationVersion))) {
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
    await ctx.scheduler.runAfter(0, internal.translations.translateDocument, {
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
    if (!(await isCurrent(ctx, args.documentId, args.languageCode, args.translationVersion))) {
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
    if (!(await isCurrent(ctx, args.documentId, args.targetLanguageCode, args.translationVersion))) {
      return false;
    }
    // Read before writing: the document row is only touched at the end of this
    // mutation, and only conditionally, so nothing else would stop an in-flight
    // chunk leaving a translation row behind for a document that was deleted
    // mid-translation.
    const document = await ctx.db.get(args.documentId);
    if (!document) return false;

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
      projectId: document.projectId,
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
    if (!document.sourceLanguageCode || document.sourceLanguageCode === "und") {
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
    if (!(await isCurrent(ctx, args.documentId, args.targetLanguageCode, args.translationVersion))) {
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
    if (!(await isCurrent(ctx, args.documentId, args.targetLanguageCode, args.translationVersion))) {
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
    if (!(await isCurrent(ctx, args.documentId, args.languageCode, args.translationVersion))) {
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
    if (!(await isCurrent(ctx, args.documentId, args.languageCode, args.translationVersion))) {
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

export const pagesByDocument = authedQuery({
  args: { documentId: v.id("documents") },
  returns: v.array(
    v.object({
      pageNumber: v.number(),
      text: v.string(),
      targetLanguageCode: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    const targetLanguageCode = (
      await languageForDocument(ctx, args.documentId)
    ).defaultLanguageCode;
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

export const retry = authedMutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBudget(ctx, ctx.user._id);
    await requireDocument(ctx, args.documentId);
    const { defaultLanguageCode: languageCode, translationVersion } =
      await languageForDocument(ctx, args.documentId);
    await ctx.runMutation(internal.translations.queueTranslation, {
      documentId: args.documentId,
      languageCode,
      translationVersion,
    });
    return null;
  },
});

const MAX_CHUNK_CHARS = 12_000;

function normalizeLanguageCode(value: string | undefined): string | undefined {
  const code = value?.trim().toLowerCase().replaceAll("_", "-");
  if (!code || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code)) return undefined;
  return code;
}

function languageMatches(source: string | undefined, target: string): boolean {
  if (!source || source === "und") return false;
  return source === target || source.split("-")[0] === target.split("-")[0];
}

/** Small deterministic fingerprint; used only to invalidate derived text. */
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function chunkEnd(text: string, offset: number): number {
  const hardEnd = Math.min(text.length, offset + MAX_CHUNK_CHARS);
  if (hardEnd === text.length) return hardEnd;
  const windowStart = Math.max(offset + Math.floor(MAX_CHUNK_CHARS * 0.7), offset);
  const paragraph = text.lastIndexOf("\n\n", hardEnd);
  if (paragraph >= windowStart) return paragraph + 2;
  const line = text.lastIndexOf("\n", hardEnd);
  if (line >= windowStart) return line + 1;
  const space = text.lastIndexOf(" ", hardEnd);
  return space >= windowStart ? space + 1 : hardEnd;
}

type TranslationContext = {
  sourceLanguageCode?: string;
  sourceLanguageIsMixed?: boolean;
  languageCode: string;
  translationVersion: number;
} | null;

type PageWork = {
  pageId: Id<"pages">;
  pageNumber: number;
  text: string;
  existingText?: string;
  existingStatus?: string;
  existingNextOffset?: number;
  existingSourceFingerprint?: string;
} | null;

export const translateDocument = internalAction({
  args: {
    documentId: v.id("documents"),
    languageCode: v.optional(v.string()),
    translationVersion: v.optional(v.number()),
    phase: v.optional(v.union(v.literal("pages"), v.literal("transcript"))),
    afterPageNumber: v.optional(v.number()),
    pageNumber: v.optional(v.number()),
    pageOffset: v.optional(v.number()),
    afterSegmentIndex: v.optional(v.number()),
    started: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context: TranslationContext = await ctx.runQuery(
      internal.translations.getContext,
      { documentId: args.documentId }
    );
    if (!context) return null;
    const languageCode = normalizeLanguageCode(args.languageCode) ?? context.languageCode;
    const translationVersion = args.translationVersion ?? context.translationVersion;
    // A superseded settings run stops without touching the newer lifecycle.
    if (
      languageCode !== context.languageCode ||
      translationVersion !== context.translationVersion
    ) {
      return null;
    }

    const sourceLanguageCode = normalizeLanguageCode(context.sourceLanguageCode);
    if (
      !args.started &&
      context.sourceLanguageIsMixed === false &&
      languageMatches(sourceLanguageCode, languageCode)
    ) {
      await ctx.runMutation(internal.translations.markNotNeeded, {
        documentId: args.documentId,
        languageCode,
        translationVersion,
      });
      return null;
    }

    if (!args.started) {
      const began: boolean = await ctx.runMutation(
        internal.translations.beginTranslation,
        { documentId: args.documentId, languageCode, translationVersion }
      );
      if (!began) return null;
    }

    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(internal.translations.failTranslation, {
        documentId: args.documentId,
        languageCode,
        translationVersion,
        errorMessage: "INTERFAZE_API_KEY not configured",
      });
      return null;
    }

    try {
      const phase = args.phase ?? "pages";
      if (phase === "pages") {
        const afterPageNumber = args.afterPageNumber ?? -1;
        const page: PageWork = await ctx.runQuery(
          internal.translations.getPageWork,
          {
            documentId: args.documentId,
            targetLanguageCode: languageCode,
            afterPageNumber,
            pageNumber: args.pageNumber,
          }
        );
        if (!page) {
          await ctx.scheduler.runAfter(0, internal.translations.translateDocument, {
            documentId: args.documentId,
            languageCode,
            translationVersion,
            phase: "transcript",
            afterSegmentIndex: -1,
            started: true,
          });
          return null;
        }

        const sourceFingerprint = fingerprint(page.text);
        if (
          page.existingStatus === "complete" &&
          page.existingSourceFingerprint === sourceFingerprint
        ) {
          await ctx.runMutation(internal.translations.activateCachedPage, {
            documentId: args.documentId,
            targetLanguageCode: languageCode,
            translationVersion,
            pageNumber: page.pageNumber,
          });
          await ctx.scheduler.runAfter(0, internal.translations.translateDocument, {
            documentId: args.documentId,
            languageCode,
            translationVersion,
            phase: "pages",
            afterPageNumber: page.pageNumber,
            started: true,
          });
          return null;
        }

        const offset =
          page.existingSourceFingerprint === sourceFingerprint
            ? (args.pageOffset ?? page.existingNextOffset ?? 0)
            : 0;
        const end = chunkEnd(page.text, offset);
        const sourceChunk = page.text.slice(offset, end);
        let translatedText = sourceChunk;
        let detectedSourceLanguageCode = sourceLanguageCode ?? "und";
        if (sourceChunk.trim()) {
          const result = await translateUnits(
            [{ id: `page:${page.pageNumber}:offset:${offset}`, text: sourceChunk }],
            languageCode,
            apiKey,
            usageLogger(ctx, { documentId: args.documentId })
          );
          translatedText = result.translations[0].text;
          detectedSourceLanguageCode =
            normalizeLanguageCode(result.sourceLanguageCode) ?? "und";
        }
        const complete = end >= page.text.length;
        const saved: boolean = await ctx.runMutation(
          internal.translations.savePageChunk,
          {
            documentId: args.documentId,
            pageId: page.pageId,
            pageNumber: page.pageNumber,
            sourceFingerprint,
            sourceLanguageCode: detectedSourceLanguageCode,
            targetLanguageCode: languageCode,
            translationVersion,
            offset,
            nextOffset: end,
            translatedText,
            complete,
          }
        );
        if (!saved) return null;
        await ctx.scheduler.runAfter(0, internal.translations.translateDocument, {
          documentId: args.documentId,
          languageCode,
          translationVersion,
          phase: "pages",
          afterPageNumber: complete ? page.pageNumber : afterPageNumber,
          ...(complete ? {} : { pageNumber: page.pageNumber, pageOffset: end }),
          started: true,
        });
        return null;
      }

      const afterSegmentIndex = args.afterSegmentIndex ?? -1;
      const transcriptBatch: {
        segments: Array<{ segmentIndex: number; text: string }>;
        lastScannedSegmentIndex: number;
        done: boolean;
      } = await ctx.runQuery(internal.translations.getTranscriptBatch, {
          documentId: args.documentId,
          afterSegmentIndex,
          targetLanguageCode: languageCode,
          translationVersion,
        });
      const segments = transcriptBatch.segments;
      if (segments.length === 0) {
        if (transcriptBatch.done) {
          await ctx.runMutation(internal.translations.completeTranslation, {
            documentId: args.documentId,
            languageCode,
            translationVersion,
          });
        } else {
          await ctx.scheduler.runAfter(0, internal.translations.translateDocument, {
            documentId: args.documentId,
            languageCode,
            translationVersion,
            phase: "transcript",
            afterSegmentIndex: transcriptBatch.lastScannedSegmentIndex,
            started: true,
          });
        }
        return null;
      }
      const result = await translateUnits(
        segments.map((segment) => ({
          id: `segment:${segment.segmentIndex}`,
          text: segment.text,
        })),
        languageCode,
        apiKey,
        usageLogger(ctx, { documentId: args.documentId })
      );
      const translatedByIndex = new Map(
        result.translations.map((translation) => [
          Number(translation.id.slice("segment:".length)),
          translation.text,
        ])
      );
      const saved: boolean = await ctx.runMutation(
        internal.translations.saveTranscriptBatch,
        {
          documentId: args.documentId,
          sourceLanguageCode:
            normalizeLanguageCode(result.sourceLanguageCode) ?? sourceLanguageCode ?? "und",
          targetLanguageCode: languageCode,
          translationVersion,
          translations: segments.map((segment) => ({
            segmentIndex: segment.segmentIndex,
            text: translatedByIndex.get(segment.segmentIndex) ?? segment.text,
          })),
        }
      );
      if (!saved) return null;
      await ctx.scheduler.runAfter(0, internal.translations.translateDocument, {
        documentId: args.documentId,
        languageCode,
        translationVersion,
        phase: "transcript",
        afterSegmentIndex: segments[segments.length - 1].segmentIndex,
        started: true,
      });
    } catch (error) {
      await ctx.runMutation(internal.translations.failTranslation, {
        documentId: args.documentId,
        languageCode,
        translationVersion,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  },
});

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { translateUnits } from "./interfaze";
import { usageLogger } from "./apiLogs";
import type { Id } from "./_generated/dataModel";

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
          await ctx.scheduler.runAfter(0, internal.translationNode.translateDocument, {
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
          await ctx.scheduler.runAfter(0, internal.translationNode.translateDocument, {
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
        await ctx.scheduler.runAfter(0, internal.translationNode.translateDocument, {
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
          await ctx.scheduler.runAfter(0, internal.translationNode.translateDocument, {
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
      await ctx.scheduler.runAfter(0, internal.translationNode.translateDocument, {
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

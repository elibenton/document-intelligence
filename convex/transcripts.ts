import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { authedQuery } from "./authz";
import { requireDocument } from "./ownership";

export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  returns: v.array(
    v.object({
      _id: v.id("transcriptSegments"),
      _creationTime: v.number(),
      documentId: v.id("documents"),
      segmentIndex: v.number(),
      speaker: v.string(),
      startTime: v.number(),
      endTime: v.number(),
      text: v.string(),
      translatedText: v.optional(v.string()),
      translatedLanguageCode: v.optional(v.string()),
      translationVersion: v.optional(v.number()),
      words: v.array(
        v.object({
          word: v.string(),
          start: v.number(),
          end: v.number(),
        })
      ),
    })
  ),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    return await ctx.db
      .query("transcriptSegments")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
  },
});

const wordValidator = v.object({
  word: v.string(),
  start: v.number(),
  end: v.number(),
});

export const ingestTranscript = internalMutation({
  args: {
    documentId: v.id("documents"),
    segments: v.array(
      v.object({
        speaker: v.string(),
        start: v.number(),
        end: v.number(),
        text: v.string(),
        words: v.array(wordValidator),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Runs before the first call that touches the document row, so nothing else
    // would stop a transcript landing for a document deleted mid-transcription.
    if ((await ctx.db.get(args.documentId)) === null) return null;

    // Replace any previous transcript for this document
    const existing = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const seg of existing) await ctx.db.delete(seg._id);

    for (let i = 0; i < args.segments.length; i++) {
      const seg = args.segments[i];
      await ctx.db.insert("transcriptSegments", {
        documentId: args.documentId,
        segmentIndex: i,
        speaker: seg.speaker,
        startTime: seg.start,
        endTime: seg.end,
        text: seg.text,
        words: seg.words,
      });
    }
    return null;
  },
});

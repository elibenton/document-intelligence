import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { authedMutation, authedQuery } from "./authz";
import { requireDocument } from "./ownership";
import { transcriptSignature } from "./speakerSignature";

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

/**
 * Hand these segments to another diarizer label — the "delete this speaker
 * label" gesture, which merges a turn into the speaker above it. Text,
 * timings, and highlights are untouched; only the label moves. The naming
 * signature is re-stamped afterwards so changing the diarization by hand
 * doesn't re-open the "who's speaking" dialog.
 */
export const reassignSpeaker = authedMutation({
  args: {
    documentId: v.id("documents"),
    segmentIds: v.array(v.id("transcriptSegments")),
    speaker: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    for (const id of args.segmentIds) {
      const row = await ctx.db.get(id);
      if (!row || row.documentId !== args.documentId) continue;
      await ctx.db.patch(id, { speaker: args.speaker });
    }
    const segments = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    await ctx.db.patch(args.documentId, {
      speakerNamingSignature: transcriptSignature(segments),
    });
    return null;
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

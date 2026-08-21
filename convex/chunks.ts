/**
 * Building the embedding units for a document.
 *
 * One chokepoint, called from `ingestParseResults` once the pages it reads
 * have been written. Chunks are a pure function of that text, so they are
 * rebuilt inline rather than scheduled: a document whose pages exist but whose
 * chunks do not is a document the semantic leg cannot see, and a gap between
 * the two writes is a window where exactly that is true.
 *
 * Delete-and-rewrite, the same discipline `ingestTranscript` uses, so a
 * re-parse converges instead of accumulating. That drops embeddings for the
 * document, which is correct — the text they described no longer exists.
 */

import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { chunkPageText, chunkTranscriptSegments } from "./chunking";
import { isRecordingDocument } from "./mediaTypes";

/**
 * Rebuild every chunk of one document from its current pages and transcript.
 *
 * Safe to call twice: it clears first, and reads only committed rows. Silent
 * on a missing document (a delete can land mid-pipeline) and on a document
 * with no pages yet.
 */
export async function rebuildForDocument(
  ctx: MutationCtx,
  documentId: Id<"documents">
): Promise<number> {
  const document = await ctx.db.get(documentId);
  if (!document) return 0;

  for (const stale of await ctx.db
    .query("chunks")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect()) {
    await ctx.db.delete(stale._id);
  }

  const pages = await ctx.db
    .query("pages")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  if (pages.length === 0) return 0;
  pages.sort((a, b) => a.pageNumber - b.pageNumber);

  const projectId = document.projectId;
  let chunkIndex = 0;

  if (isRecordingDocument(document)) {
    const segments = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    // A recording's transcript is mirrored onto page 0, which is also where
    // its blocks and highlights anchor.
    const page = pages.find((p) => p.pageNumber === 0) ?? pages[0];
    const windows = chunkTranscriptSegments(
      segments.map((s) => ({
        speaker: s.speaker,
        text: s.text,
        start: s.startTime,
        end: s.endTime,
      }))
    );
    for (const window of windows) {
      await ctx.db.insert("chunks", {
        documentId,
        projectId,
        pageId: page._id,
        pageNumber: page.pageNumber,
        chunkIndex: chunkIndex++,
        text: window.text,
        startTime: window.startTime,
        endTime: window.endTime,
      });
    }
    // Diarization can be absent (a transcribe that failed, an older row), and
    // the mirrored text is still on the page. Falling through to page
    // chunking then costs the time anchors but keeps the audio searchable,
    // which is the tradeoff worth making.
    if (chunkIndex > 0) return chunkIndex;
  }

  for (const page of pages) {
    for (const chunk of chunkPageText(page.text)) {
      await ctx.db.insert("chunks", {
        documentId,
        projectId,
        pageId: page._id,
        pageNumber: page.pageNumber,
        chunkIndex: chunkIndex++,
        text: chunk.text,
        startChar: chunk.startChar,
        endChar: chunk.endChar,
      });
    }
  }
  return chunkIndex;
}


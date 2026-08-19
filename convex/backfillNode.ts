"use node";

/**
 * Storage-reading half of the source-native metadata backfill: pulls each
 * stored PDF/image/audio/video and re-derives what the forward path now
 * captures at upload — creation date and (for recordings) duration. All
 * deterministic binary parsing, zero Interfaze calls.
 *
 * In "use node" because mediabunny is proven in Node and unproven in Convex's
 * V8 runtime; the leaf parsers (exifDate/mediaDates/pdfDateScan) run anywhere.
 * Commits go through backfill.commitNativeBackfill, which re-sanitizes and
 * honors provenance stamps — a human edit or tombstone is never overwritten.
 *
 *   npx convex run backfillNode:backfillNativeMetadata
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { exifCreatedDate } from "./exifDate";
import { exifStringToIso } from "./nativeDate";
import { mp4CreationDate, wavBextOriginationDate } from "./mediaDates";
import { scanPdfCreationDate } from "./pdfDateScan";

/** Whole-buffer parsers stay off files that would strain action memory. */
const MAX_BYTES = 64 * 1024 * 1024;

export const backfillNativeMetadata = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.runQuery(internal.backfill.pageDocuments, {
      cursor: args.cursor ?? null,
    });

    for (const doc of page.documents) {
      const media = doc.mediaType;
      const isRecording = media === "audio" || media === "video";
      const wantsDate =
        (media === "pdf" || media === "image" || isRecording) &&
        !doc.hasSourceCreatedDate &&
        (doc.createdDateSource === undefined ||
          doc.createdDateSource === "ai");
      const wantsDuration = isRecording && doc.durationSeconds === undefined;
      if (!wantsDate && !wantsDuration) continue;
      if ((doc.sizeBytes ?? 0) > MAX_BYTES) continue;

      try {
        const blob = await ctx.storage.get(doc.storageId);
        if (!blob) continue;

        let createdDate: string | undefined;
        let durationSeconds: number | undefined;

        if (media === "pdf") {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          createdDate = scanPdfCreationDate(bytes) ?? undefined;
        } else if (media === "image") {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          createdDate =
            exifStringToIso(exifCreatedDate(bytes)) ?? undefined;
        } else if (isRecording) {
          const facts = await readRecording(blob, wantsDuration);
          createdDate = facts.createdDate;
          durationSeconds = facts.durationSeconds;
        }

        if (createdDate || durationSeconds !== undefined) {
          await ctx.runMutation(internal.backfill.commitNativeBackfill, {
            documentId: doc._id,
            createdDate: wantsDate ? createdDate : undefined,
            durationSeconds: wantsDuration ? durationSeconds : undefined,
          });
        }
      } catch {
        continue; // one unreadable file must not stop the sweep
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillNode.backfillNativeMetadata,
        { cursor: page.continueCursor }
      );
    }
    return null;
  },
});

/** mediabunny tags/duration first, then the mvhd/BEXT head-slice parsers. */
async function readRecording(
  blob: Blob,
  wantDuration: boolean
): Promise<{ createdDate?: string; durationSeconds?: number }> {
  let createdDate: string | undefined;
  let durationSeconds: number | undefined;
  try {
    const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny");
    const input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    });
    try {
      if (await input.canRead()) {
        const tags = await input.getMetadataTags();
        if (tags.date instanceof Date && !Number.isNaN(tags.date.getTime())) {
          createdDate = tags.date.toISOString().slice(0, 10);
        }
        if (wantDuration) {
          const duration = await input.computeDuration();
          if (Number.isFinite(duration) && duration > 0) {
            durationSeconds = duration;
          }
        }
      }
    } finally {
      input.dispose();
    }
  } catch {
    /* mediabunny unavailable or unreadable — the leaf parsers still run */
  }
  if (!createdDate) {
    const head = new Uint8Array(
      await blob.slice(0, 1_500_000).arrayBuffer()
    );
    createdDate =
      mp4CreationDate(head) ?? wavBextOriginationDate(head) ?? undefined;
  }
  return { createdDate, durationSeconds };
}

import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { RENDERER_VERSION } from "./rendererConfig";
import { processingEnqueueOptions, processingPool } from "./processingPool";
import { renderEnqueueOptions, renderPool } from "./renderPool";

// Interfaze accepts URLs in prompt text up to 80 MB. Keep headroom for its
// fetch/redirect accounting and mirror the browser preflight's safe ceiling.
const AUDIO_URL_SAFE_BYTES = 70_000_000;

export const generateUploadUrl = mutation(async (ctx) => {
  return await ctx.storage.generateUploadUrl();
});

/**
 * Objective media type for a upload, from its MIME type with a filename
 * fallback (browsers hand over an empty `type` often enough to matter).
 *
 * Returns "other" for anything unrecognized. This used to default to "pdf",
 * which quietly routed spreadsheets, text files and the like into pdf.js
 * rasterization — which fails in ways that read as "the parser broke" rather
 * than "this file isn't supported".
 */
export function detectMediaType(mimeType: string, name = ""): string {
  const mime = mimeType.toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/csv" || mime === "application/csv" || ext === "csv") {
    return "csv";
  }
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    // Interfaze reads .docx natively; page images come from convex/docxRender.
    // Legacy binary .doc is a different format and stays unsupported.
    return "docx";
  }
  if (mime === "text/html") return "webScrape";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";

  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"].includes(ext)) {
    return "image";
  }
  if (["mp3", "m4a", "wav", "aac", "ogg", "flac"].includes(ext)) return "audio";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  return "other";
}

export const createDocument = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    storageId: v.id("_storage"),
    mimeType: v.string(),
  },
  handler: async (ctx, args) => {
    const storedFile = await ctx.db.system.get("_storage", args.storageId);
    if (!storedFile) throw new Error("Uploaded file not found in storage");

    const verifiedMimeType = storedFile.contentType || args.mimeType;
    const mediaType = detectMediaType(verifiedMimeType, args.name);

    const documentId = await ctx.db.insert("documents", {
      projectId: args.projectId,
      name: args.name,
      storageId: args.storageId,
      mimeType: verifiedMimeType,
      mediaType,
      status: "uploaded",
      uploadedAt: Date.now(),
    });

    // Nothing downstream can read this file — fail it here with a reason
    // rather than letting the PDF path discover it and report a parser error.
    if (mediaType === "other") {
      await ctx.db.patch(documentId, {
        status: "failed",
        errorMessage: `Unsupported file type${
          args.mimeType ? ` (${args.mimeType})` : ""
        } — upload a PDF, DOCX, CSV, image, audio, or video file.`,
      });
      return documentId;
    }

    // Keep oversized recordings out of a provider request that cannot
    // succeed. The original remains in storage so a future normalization job
    // can create a compressed derivative without requiring another upload.
    if (mediaType === "audio" && storedFile.size > AUDIO_URL_SAFE_BYTES) {
      await ctx.db.patch(documentId, {
        status: "failed",
        errorMessage: `${Math.round(storedFile.size / 1_000_000)} MB audio needs optimization before Interfaze can transcribe it. Automatic audio optimization is not connected yet.`,
      });
      return documentId;
    }

    const isRecording = mediaType === "audio" || mediaType === "video";
    const stage = isRecording ? "transcribe" : "parse";
    const { paused } = await ctx.runQuery(internal.processingControl.getInternal, {});
    const workId = await processingPool.enqueueAction(
      ctx,
      isRecording
        ? internal.processingNode.runTranscribe
        : internal.processingNode.runDocumentUnderstanding,
      { documentId },
      // Interfaze may have completed a request before a network failure is
      // observed, so automatic retries could duplicate a billable call.
      processingEnqueueOptions(paused)
    );
    await ctx.db.insert("processingJobs", {
      documentId,
      stage,
      status: "pending",
      queuedAt: Date.now(),
      workId,
    });

    // Render page images independently for the viewer. Interfaze receives the
    // original whole PDF, so rendering is no longer on the analysis critical
    // path.
    if (mediaType === "pdf" || mediaType === "docx") {
      await ctx.db.patch(documentId, {
        renderStatus: "queued",
        renderedPageCount: 0,
        rendererVersion: RENDERER_VERSION,
        renderAttempts: 0,
        renderScheduledAt: Date.now(),
      });
      await renderPool.enqueueAction(
        ctx,
        internal.renderPages.renderBatch,
        { documentId, startPage: 0 },
        renderEnqueueOptions(documentId)
      );
    }

    return documentId;
  },
});

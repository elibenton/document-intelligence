import { type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { RENDERER_VERSION } from "./rendererConfig";
import { authedMutation, authedQuery } from "./authz";
import { PROVIDER_URL_SAFE_BYTES } from "./interfazeLimits";
import { requireProject } from "./ownership";
import { requireBudget } from "./budget";

export const generateUploadUrl = authedMutation(async (ctx) => {
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

/**
 * The document in `projectId` that `contentHash` already belongs to, if any.
 *
 * A missing hash is never a match: rows uploaded before the field existed, and
 * web clips (which have no selected file), both carry none, and treating those
 * as equal to each other would collapse unrelated documents.
 */
async function findByContentHash(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  contentHash: string | undefined
) {
  if (!contentHash) return null;
  return await ctx.db
    .query("documents")
    .withIndex("by_project_hash", (q) =>
      q.eq("projectId", projectId).eq("contentHash", contentHash)
    )
    .first();
}

/**
 * Whether a file is already in this project, asked *before* the bytes are
 * uploaded — the browser hashes the file it is about to send, so the duplicate
 * costs one indexed read instead of a full transfer.
 *
 * `sameName` is reported separately and is deliberately not a duplicate: the
 * user re-exporting "invoice.pdf" with a correction wants the new version.
 * It exists to explain the two rows that will otherwise look identical in the
 * library, which is the actual complaint behind "check the file name".
 */
export const findDuplicate = authedQuery({
  args: {
    projectId: v.id("projects"),
    contentHash: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    const exact = await findByContentHash(ctx, args.projectId, args.contentHash);
    if (exact) {
      return {
        exact: { _id: exact._id, name: exact.displayName ?? exact.name },
        sameName: null,
      };
    }
    const sameName = await ctx.db
      .query("documents")
      .withIndex("by_project_name", (q) =>
        q.eq("projectId", args.projectId).eq("name", args.name)
      )
      .first();
    return {
      exact: null,
      sameName: sameName ? { _id: sameName._id, name: sameName.name } : null,
    };
  },
});

export const createDocument = authedMutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    storageId: v.id("_storage"),
    mimeType: v.string(),
    /** Hex SHA-256 of the selected file; see documents.contentHash. */
    contentHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireBudget(ctx, ctx.user._id);
    await requireProject(ctx, args.projectId);
    const storedFile = await ctx.db.system.get("_storage", args.storageId);
    if (!storedFile) throw new Error("Uploaded file not found in storage");

    // Backstop for the browser's pre-upload check: two tabs, or the same file
    // twice in one folder drop, can both pass it. Nothing has been enqueued
    // yet, so dropping the redundant blob here costs only the transfer that
    // already happened — no second billable pipeline run.
    const duplicate = await findByContentHash(
      ctx,
      args.projectId,
      args.contentHash
    );
    if (duplicate) {
      await ctx.storage.delete(args.storageId);
      return {
        documentId: duplicate._id,
        duplicateOf: duplicate.displayName ?? duplicate.name,
      };
    }

    const verifiedMimeType = storedFile.contentType || args.mimeType;
    const mediaType = detectMediaType(verifiedMimeType, args.name);

    const documentId = await ctx.db.insert("documents", {
      projectId: args.projectId,
      name: args.name,
      storageId: args.storageId,
      contentHash: args.contentHash,
      mimeType: verifiedMimeType,
      sizeBytes: storedFile.size,
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
      return { documentId, duplicateOf: null };
    }

    // Keep oversized recordings out of a provider request that cannot
    // succeed. The original remains in storage so a future normalization job
    // can create a compressed derivative without requiring another upload.
    if (mediaType === "audio" && storedFile.size > PROVIDER_URL_SAFE_BYTES) {
      await ctx.db.patch(documentId, {
        status: "failed",
        errorMessage: `${Math.round(storedFile.size / 1_000_000)} MB audio needs optimization before Interfaze can transcribe it. Automatic audio optimization is not connected yet.`,
      });
      return { documentId, duplicateOf: null };
    }

    const isRecording = mediaType === "audio" || mediaType === "video";
    const stage = isRecording ? "transcribe" : "parse";
    // No automatic retries anywhere on this path: Interfaze may have
    // completed a request before a network failure is observed, so a retry
    // could duplicate a billable call.
    const workId = await ctx.scheduler.runAfter(
      0,
      isRecording
        ? internal.processingNode.runTranscribe
        : internal.processingNode.runDocumentUnderstanding,
      { documentId }
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
      await ctx.scheduler.runAfter(0, internal.renderPages.renderBatch, {
        documentId,
        startPage: 0,
      });
    }

    return { documentId, duplicateOf: null };
  },
});

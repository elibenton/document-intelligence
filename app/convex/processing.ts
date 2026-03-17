import { action, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// Trigger the ML pipeline on Modal
export const triggerPipeline = action({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    // Get the document
    const document = await ctx.runQuery(
      (await import("./_generated/api")).api.documents.get,
      { id: args.documentId }
    );
    if (!document) throw new Error("Document not found");

    // Get a download URL for the PDF
    const pdfUrl = await ctx.storage.getUrl(document.storageId);
    if (!pdfUrl) throw new Error("PDF file not found in storage");

    // Update status to processing
    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "ocr_processing",
    });

    // Update the OCR job status
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "ocr",
      status: "running",
    });

    // Get the Convex site URL for callbacks
    const convexSiteUrl = process.env.CONVEX_SITE_URL;
    if (!convexSiteUrl) throw new Error("CONVEX_SITE_URL not configured");

    // Call Modal endpoint
    const modalUrl = process.env.MODAL_ENDPOINT_URL;
    if (!modalUrl) throw new Error("MODAL_ENDPOINT_URL not configured");

    const response = await fetch(modalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: args.documentId,
        pdfUrl,
        convexSiteUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      await ctx.runMutation(internal.processing.markFailed, {
        documentId: args.documentId,
        errorMessage: `Modal error: ${error}`,
      });
    }
  },
});

export const updateStatus = internalMutation({
  args: {
    documentId: v.id("documents"),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, { status: args.status });
  },
});

export const updateJobStatus = internalMutation({
  args: {
    documentId: v.id("documents"),
    stage: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", args.stage)
      )
      .first();
    if (job) {
      await ctx.db.patch(job._id, {
        status: args.status,
        ...(args.status === "running" ? { startedAt: Date.now() } : {}),
      });
    }
  },
});

export const markFailed = internalMutation({
  args: {
    documentId: v.id("documents"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, {
      status: "failed",
      errorMessage: args.errorMessage,
    });

    // Mark all pending/running jobs as failed
    const jobs = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const job of jobs) {
      if (job.status === "pending" || job.status === "running") {
        await ctx.db.patch(job._id, {
          status: "failed",
          errorMessage: args.errorMessage,
        });
      }
    }
  },
});

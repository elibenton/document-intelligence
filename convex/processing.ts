import { action, internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { parse, extract } from "./datalab";

// ---------------------------------------------------------------------------
// Step 1: Parse — convert PDF to markdown + JSON blocks
// ---------------------------------------------------------------------------

export const runParse = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(
      (await import("./_generated/api")).api.documents.get,
      { id: args.documentId }
    );
    if (!document) throw new Error("Document not found");

    const apiKey = process.env.DATALAB_API_KEY;
    if (!apiKey) throw new Error("DATALAB_API_KEY not configured");

    // Get the PDF file from Convex storage
    const pdfBlob = await ctx.storage.get(document.storageId);
    if (!pdfBlob) throw new Error("PDF file not found in storage");
    const pdfBuffer = await pdfBlob.arrayBuffer();

    // Update status
    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "parsing",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "parse",
      status: "running",
    });

    try {
      const result = await parse(pdfBuffer, document.name, apiKey, {
        saveCheckpoint: true,
      });

      // Ingest the parsed results
      await ctx.runMutation(internal.ingest.ingestParseResults, {
        documentId: args.documentId,
        markdown: result.markdown,
        blocks: (result.json ?? []).map((block) => ({
          blockId: block.id ?? "",
          blockType: block.block_type ?? "Text",
          text: block.text ?? "",
          html: block.html,
          pageNumber: block.page ?? 0,
          bbox: block.bbox,
        })),
        pageDimensions: result.pageDimensions,
        pageCount: result.page_count,
        checkpointId: result.checkpoint_id,
      });

      // Mark parse job complete
      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "parse",
        status: "completed",
      });

      // Update document status
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
        status: "parsed",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.processing.markFailed, {
        documentId: args.documentId,
        errorMessage: `Parse failed: ${msg}`,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Step 3: Extract — structured data extraction via JSON schema
// ---------------------------------------------------------------------------

export const runExtract = internalAction({
  args: {
    documentId: v.id("documents"),
    pageSchema: v.string(), // JSON string of the extraction schema
    pageRange: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(
      (await import("./_generated/api")).api.documents.get,
      { id: args.documentId }
    );
    if (!document) throw new Error("Document not found");

    const apiKey = process.env.DATALAB_API_KEY;
    if (!apiKey) throw new Error("DATALAB_API_KEY not configured");

    const pdfBlob = await ctx.storage.get(document.storageId);
    if (!pdfBlob) throw new Error("PDF file not found in storage");
    const pdfBuffer = await pdfBlob.arrayBuffer();

    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "extracting",
    });
    await ctx.runMutation(internal.processing.createJob, {
      documentId: args.documentId,
      stage: "extract",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "extract",
      status: "running",
    });

    try {
      const schema = JSON.parse(args.pageSchema);
      const result = await extract(pdfBuffer, document.name, apiKey, schema, {
        checkpointId: document.datalabCheckpointId,
        pageRange: args.pageRange,
      });

      await ctx.runMutation(internal.ingest.ingestExtractResults, {
        documentId: args.documentId,
        schemaUsed: args.pageSchema,
        results: result.extraction_schema_json,
        pageRange: args.pageRange,
      });

      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "extract",
        status: "completed",
      });
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
        status: "completed",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.processing.markFailed, {
        documentId: args.documentId,
        errorMessage: `Extract failed: ${msg}`,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Run the full pipeline: parse → extract
// ---------------------------------------------------------------------------

const PEOPLE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    people: {
      type: "array",
      items: { type: "string" },
      description:
        "Individual, unique people, not titles or occupations - names",
    },
  },
  required: ["people"],
});

export const runFullPipeline = action({
  args: {
    documentId: v.id("documents"),
  },
  handler: async (ctx, args) => {
    // Step 1: Parse
    await ctx.runAction(internal.processing.runParse, {
      documentId: args.documentId,
    });

    // Step 2: Extract people
    await ctx.runAction(internal.processing.runExtract, {
      documentId: args.documentId,
      pageSchema: PEOPLE_SCHEMA,
    });
  },
});

// ---------------------------------------------------------------------------
// Extract entities from an already-parsed document
// ---------------------------------------------------------------------------

export const runExtraction = action({
  args: {
    documentId: v.id("documents"),
    pageSchema: v.string(),
    pageRange: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.runAction(internal.processing.runExtract, {
      documentId: args.documentId,
      pageSchema: args.pageSchema,
      pageRange: args.pageRange,
    });
  },
});

// ---------------------------------------------------------------------------
// Internal mutations for status management
// ---------------------------------------------------------------------------

export const updateStatus = internalMutation({
  args: {
    documentId: v.id("documents"),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, {
      status: args.status,
      errorMessage: undefined,
    });
  },
});

export const createJob = internalMutation({
  args: {
    documentId: v.id("documents"),
    stage: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if job already exists
    const existing = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("stage", args.stage)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { status: "pending", errorMessage: undefined });
      return;
    }
    await ctx.db.insert("processingJobs", {
      documentId: args.documentId,
      stage: args.stage,
      status: "pending",
    });
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
        ...(args.status === "completed" ? { completedAt: Date.now() } : {}),
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

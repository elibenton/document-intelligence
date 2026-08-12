"use node";

/**
 * Document pipeline — Node-runtime half. Every stage that calls Interfaze
 * (parse/OCR, extract, transcribe, template extraction) lives here under
 * "use node" because the Interfaze SDK needs the Node runtime. The status
 * mutations and pure-scheduling actions it drives stay in processing.ts on the
 * default runtime and are reached by function reference.
 */

import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import {
  understandDocument,
  extract,
  transcribe,
  failureCodeOf,
} from "./interfaze";
import type { OcrPageResult } from "./interfaze";
import { usageLogger } from "./apiLogs";
import type { Doc, Id } from "./_generated/dataModel";
import Papa from "papaparse";

// Watchdog: actions that hit Convex's 10-minute kill never run their catch
// blocks, stranding documents in "parsing"/"extracting" with a "running" job
// forever. Every stage schedules failIfStuck as a dead-man's switch; a job
// still "running" past the action lifetime is dead by definition.
const WATCHDOG_DELAY_MS = 12 * 60 * 1000;
const CSV_INDEX_BYTES = 700_000;
const CSV_INDEX_ROWS = 2_000;
const CSV_ROWS_PER_PAGE = 100;

function isCsvDocument(document: Doc<"documents">): boolean {
  const mime = document.mimeType.toLowerCase();
  return (
    document.mediaType === "csv" ||
    mime === "text/csv" ||
    mime === "application/csv" ||
    document.name.toLowerCase().endsWith(".csv")
  );
}

/**
 * Build deterministic, bounded search pages for a CSV without trying to
 * rasterize it. Interfaze still receives and analyzes the complete original;
 * this local preview exists for full-text search, citations, and the document
 * sidebar. Limiting both bytes and rows keeps the ingest mutation comfortably
 * below Convex's argument and write limits even for very large datasets.
 */
async function csvSearchPages(
  ctx: ActionCtx,
  document: Doc<"documents">
): Promise<OcrPageResult[]> {
  const blob = await ctx.storage.get(document.storageId);
  if (!blob) throw new Error("CSV not found in storage");
  const source = await blob.slice(0, CSV_INDEX_BYTES).text();
  const parsed = Papa.parse<string[]>(source.replace(/^\uFEFF/, ""), {
    preview: CSV_INDEX_ROWS + 1,
    skipEmptyLines: "greedy",
  });
  const rows = parsed.data.map((row) =>
    row.map((cell) => String(cell ?? "").replaceAll("\u0000", ""))
  );
  if (rows.length === 0 || rows.every((row) => row.every((cell) => !cell))) {
    throw new Error("CSV contains no readable rows");
  }

  const headers = rows[0];
  const bodyRows = rows.slice(1, CSV_INDEX_ROWS + 1);
  const chunks = bodyRows.length > 0
    ? Array.from(
        { length: Math.ceil(bodyRows.length / CSV_ROWS_PER_PAGE) },
        (_, index) =>
          bodyRows.slice(
            index * CSV_ROWS_PER_PAGE,
            (index + 1) * CSV_ROWS_PER_PAGE
          )
      )
    : [[]];

  return chunks.map((chunk, pageNumber) => {
    const firstRowNumber = pageNumber * CSV_ROWS_PER_PAGE + 1;
    const text = [
      `Columns: ${headers.join("\t")}`,
      ...chunk.map(
        (row, index) => `Row ${firstRowNumber + index}: ${row.join("\t")}`
      ),
    ].join("\n");
    return {
      pageNumber,
      text,
      blocks: [
        {
          id: `p${pageNumber}_csv`,
          block_type: "CSVRows",
          text,
          page: pageNumber,
        },
      ],
    };
  });
}

const DOCUMENT_UNDERSTANDING_SCHEMA = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      description:
        "Every page in the uploaded document, in file order, with complete verbatim OCR text in the original language. Never translate, summarize, merge, or omit pages.",
      items: {
        type: "object",
        properties: {
          page_number: {
            type: "integer",
            description: "1-based position of the page in the uploaded file",
          },
          text: {
            type: "string",
            description: "Complete verbatim OCR text for this page",
          },
        },
        required: ["page_number", "text"],
      },
    },
    title: {
      type: "string",
      description: "Document title as written, or a concise descriptive title",
    },
    summary: {
      type: "string",
      description: "A factual 2-3 sentence summary of the complete document",
    },
    date: {
      type: "string",
      description: "Primary date of the document (ISO if possible), or Unknown",
    },
    author: {
      type: "string",
      description: "Author or creator if identifiable, or Unknown",
    },
    language: { type: "string", description: "Primary document language" },
    source_language_code: {
      type: "string",
      description: "Primary document language as a lowercase ISO 639 code",
    },
    is_multilingual: {
      type: "boolean",
      description: "True when meaningful passages use more than one language",
    },
    primary_kind: {
      type: "string",
      description: "Concise lowercase semantic document kind",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "3-6 concise lowercase topical tags",
    },
    suggested_roles: {
      type: "array",
      description: "Entity roles worth extracting from this document kind",
      items: {
        type: "object",
        properties: {
          role: { type: "string" },
          question: { type: "string" },
          entity_type: {
            type: "string",
            enum: ["person", "organization", "place", "other"],
          },
        },
        required: ["role", "question", "entity_type"],
      },
    },
    additional: {
      type: "array",
      description: "Other notable metadata as key/value pairs",
      items: {
        type: "object",
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
      },
    },
    graphic_objects: {
      type: "array",
      description:
        "Visually verified non-body-text objects, including signatures, redactions, stamps or seals, handwriting, photographs, logos, charts, and other graphics. Empty if none.",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          description: { type: "string" },
          page_number: { type: "integer", description: "1-based page number" },
          top_left_x: { type: "number" },
          top_left_y: { type: "number" },
          bottom_right_x: { type: "number" },
          bottom_right_y: { type: "number" },
          confidence: { type: "number", description: "0-1 confidence" },
        },
        required: [
          "label",
          "description",
          "page_number",
          "top_left_x",
          "top_left_y",
          "bottom_right_x",
          "bottom_right_y",
          "confidence",
        ],
      },
    },
  },
  required: [
    "pages",
    "title",
    "summary",
    "date",
    "author",
    "language",
    "source_language_code",
    "is_multilingual",
    "primary_kind",
    "tags",
    "suggested_roles",
    "additional",
    "graphic_objects",
  ],
};

interface StructuredGraphicObject {
  label?: string;
  description?: string;
  page_number?: number;
  top_left_x?: number;
  top_left_y?: number;
  bottom_right_x?: number;
  bottom_right_y?: number;
  confidence?: number;
}

function structuredDetections(
  content: string,
  pages: Array<{ pageNumber: number; width?: number; height?: number }>
) {
  let parsed: { graphic_objects?: StructuredGraphicObject[] };
  try {
    parsed = JSON.parse(content) as { graphic_objects?: StructuredGraphicObject[] };
  } catch {
    return [];
  }
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  return (parsed.graphic_objects ?? []).flatMap((object) => {
    const pageNumber = Math.max(0, Math.round(object.page_number ?? 1) - 1);
    const page = pages.find((candidate) => candidate.pageNumber === pageNumber);
    const coordinates = [
      object.top_left_x,
      object.top_left_y,
      object.bottom_right_x,
      object.bottom_right_y,
    ];
    if (
      !object.label?.trim() ||
      coordinates.some((coordinate) => typeof coordinate !== "number")
    ) {
      return [];
    }
    const [rawLeft, rawTop, rawRight, rawBottom] = coordinates as number[];
    const alreadyNormalized = coordinates.every(
      (coordinate) => (coordinate ?? 0) >= 0 && (coordinate ?? 0) <= 1
    );
    if (!alreadyNormalized && (!page?.width || !page.height)) return [];
    const left = alreadyNormalized ? rawLeft : rawLeft / page!.width!;
    const top = alreadyNormalized ? rawTop : rawTop / page!.height!;
    const right = alreadyNormalized ? rawRight : rawRight / page!.width!;
    const bottom = alreadyNormalized ? rawBottom : rawBottom / page!.height!;
    return [
      {
        pageNumber,
        label: object.label.trim().toLowerCase().replace(/\s+/g, "_"),
        description: (object.description ?? object.label).slice(0, 500),
        confidence: clamp01(object.confidence ?? 0.5),
        bbox: {
          x: clamp01(Math.min(left, right)),
          y: clamp01(Math.min(top, bottom)),
          width: clamp01(Math.abs(right - left)),
          height: clamp01(Math.abs(bottom - top)),
        },
      },
    ];
  });
}


async function armWatchdog(
  ctx: ActionCtx,
  documentId: Id<"documents">,
  stage: string
) {
  await ctx.scheduler.runAfter(WATCHDOG_DELAY_MS, internal.processing.failIfStuck, {
    documentId,
    stage,
  });
}

/** Translation is derived and must never turn a successful parse into a
 * failed source document. Queueing errors are surfaced on the translation
 * lifecycle when a retry is attempted, while the canonical source stays live. */
async function scheduleTranslation(
  ctx: ActionCtx,
  documentId: Id<"documents">
): Promise<void> {
  try {
    const translationSettings: {
      defaultLanguageCode: string;
      translationVersion: number;
    } = await ctx.runQuery(internal.settings.getInternal, {});
    await ctx.scheduler.runAfter(0, internal.translationNode.translateDocument, {
      documentId,
      languageCode: translationSettings.defaultLanguageCode,
      translationVersion: translationSettings.translationVersion,
    });
  } catch (error) {
    console.error(
      "Failed to queue derived translation:",
      error instanceof Error ? error.message : String(error)
    );
  }
}


/**
 * Stage-prefix a failure message — except for classified provider failures,
 * whose message already names the cause and the fix in the user's terms.
 * "Parse failed: Interfaze API credits exhausted — add credits…" buries the
 * only part the reader can act on behind a stage label they don't need.
 */
function stageMessage(stage: string, e: unknown, msg: string): string {
  return failureCodeOf(e) ? msg : `${stage} failed: ${msg}`;
}


/**
 * What to hand Interfaze for a document: web clips inline their markdown
 * article text (Interfaze only reliably fetches PDF/image URLs); everything
 * else is referenced by its stable storage URL (which doubles as Interfaze's
 * cache key).
 */
async function extractionSource(
  ctx: ActionCtx,
  document: Doc<"documents">
): Promise<string | { inlineText: string }> {
  if (document.textStorageId) {
    const blob = await ctx.storage.get(document.textStorageId);
    if (blob) return { inlineText: await blob.text() };
  }
  const url = await ctx.storage.getUrl(document.storageId);
  if (!url) throw new Error("File not found in storage");
  return url;
}


// ---------------------------------------------------------------------------
// Primary upload path: one whole-document Interfaze completion. OCR and object
// detection run before the structured metadata analysis is returned.
// ---------------------------------------------------------------------------

export const runDocumentUnderstanding = internalAction({
  args: {
    documentId: v.id("documents"),
    bypassCache: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(api.documents.get, {
      id: args.documentId,
    });
    if (!document) throw new Error("Document not found");

    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");
    const fileUrl = await requireFileUrl(ctx, document);
    const csvPages = isCsvDocument(document)
      ? await csvSearchPages(ctx, document)
      : null;
    const kinds: Doc<"documentKinds">[] = await ctx.runQuery(api.kinds.list, {});
    const kindNames = kinds.map((kind) => kind.name);

    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "parsing",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "parse",
      status: "running",
    });
    await armWatchdog(ctx, args.documentId, "parse");

    try {
      const result = await understandDocument(
        fileUrl,
        document.name,
        apiKey,
        {
          log: usageLogger(ctx, { documentId: args.documentId }),
          systemPrompt: isCsvDocument(document)
            ? "You are a meticulous data-understanding system. Parse the complete CSV, preserve the meaning of its rows and columns, and use Unknown when metadata is uncertain."
            : "You are a meticulous document-understanding system. Perform OCR and object detection over the complete document in one pass. Return complete verbatim page text in the original language plus only visually verified graphic objects. Be factual, never infer a visual object from nearby text, and use Unknown when metadata is uncertain.",
          prompt: `${
            isCsvDocument(document)
              ? "Read and analyze the complete CSV dataset. Identify its columns, row semantics, subject, and notable structure. Return the requested metadata; pages and graphic_objects must be empty."
              : "Read every page of the complete document once. Return each page's complete verbatim OCR text, the requested metadata, and every visually verified non-body-text object. Preserve Spanish and all other source languages exactly. Do not omit later pages."
          }${
            kindNames.length > 0
              ? ` Existing document kinds: ${kindNames.join(", ")}. Use one when it fits; otherwise propose a concise new lowercase kind.`
              : ""
          }`,
          responseSchema: {
            name: "document_understanding",
            schema: DOCUMENT_UNDERSTANDING_SCHEMA,
          },
          bypassCache: args.bypassCache,
        }
      );

      const parsedPages = csvPages ?? result.pages;
      if (parsedPages.length === 0) {
        throw new Error(
          "Interfaze returned neither OCR precontext nor structured page text"
        );
      }
      const detections = isCsvDocument(document)
        ? []
        : structuredDetections(result.content, parsedPages);
      console.log(
        `Document understanding returned ${parsedPages.length} parsed pages from ${csvPages ? "csv" : result.pageSource} and ${detections.length} stored visual objects`
      );

      await ctx.runMutation(internal.ingest.ingestParseResults, {
        documentId: args.documentId,
        pageText: parsedPages.map((page) => page.text),
        blocks: parsedPages.flatMap((page) =>
          page.blocks.map((block) => ({
            blockId: block.id,
            blockType: block.block_type,
            text: block.text,
            pageNumber: block.page,
            bbox: block.bbox,
            confidence: block.confidence,
            words: block.words,
          }))
        ),
        pageDimensions: parsedPages.flatMap((page) =>
          page.width && page.height
            ? [{ page: page.pageNumber, width: page.width, height: page.height }]
            : []
        ),
        pageCount: parsedPages.length,
      });
      await ctx.runMutation(internal.metadata.saveMetadataResult, {
        documentId: args.documentId,
        raw: result.content,
      });
      const structured = JSON.parse(result.content) as {
        source_language_code?: string;
        is_multilingual?: boolean;
      };
      if (structured.source_language_code) {
        await ctx.runMutation(internal.translations.setSourceLanguage, {
          documentId: args.documentId,
          sourceLanguageCode: structured.source_language_code,
          sourceLanguageIsMixed: structured.is_multilingual,
        });
      }
      await ctx.runMutation(internal.detections.saveDetections, {
        documentId: args.documentId,
        detections,
      });

      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "parse",
        status: "completed",
      });
      await ctx.scheduler.runAfter(0, internal.embeddings.embedDocument, {
        documentId: args.documentId,
      });
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
        status: "parsed",
      });
      await scheduleTranslation(ctx, args.documentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.processing.markFailed, {
        documentId: args.documentId,
        errorMessage: stageMessage("Document understanding", error, message),
        errorCode: failureCodeOf(error),
      });
    }
    return null;
  },
});

/** Storage URL for a document's own file (not its rendered pages). */
async function requireFileUrl(
  ctx: ActionCtx,
  document: Doc<"documents">
): Promise<string> {
  const url = await ctx.storage.getUrl(document.storageId);
  if (!url) throw new Error("File not found in storage");
  return url;
}


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

    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");

    const source = await extractionSource(ctx, document);

    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "extracting",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "extract",
      status: "running",
    });
    await armWatchdog(ctx, args.documentId, "extract");

    try {
      const schema = JSON.parse(args.pageSchema);
      const result = await extract(source, apiKey, schema, {
        pageRange: args.pageRange,
        log: usageLogger(ctx, { documentId: args.documentId }),
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
        errorMessage: stageMessage("Extract", e, msg),
        errorCode: failureCodeOf(e),
      });
    }
  },
});


// ---------------------------------------------------------------------------
// Transcribe — audio/video → diarized transcript with word timestamps.
// The transcript text is also ingested as a single "page" so search and
// entity extraction work on recordings the same way they do on documents.
// ---------------------------------------------------------------------------

export const runTranscribe = internalAction({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(api.documents.get, {
      id: args.documentId,
    });
    if (!document) throw new Error("Document not found");

    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");

    const fileUrl = await ctx.storage.getUrl(document.storageId);
    if (!fileUrl) throw new Error("Media file not found in storage");

    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "parsing",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "transcribe",
      status: "running",
    });
    await armWatchdog(ctx, args.documentId, "transcribe");

    try {
      const transcript = await transcribe(
        fileUrl,
        apiKey,
        usageLogger(ctx, { documentId: args.documentId })
      );
      const segments = transcript.segments;

      await ctx.runMutation(internal.transcripts.ingestTranscript, {
        documentId: args.documentId,
        segments,
      });
      await ctx.runMutation(internal.translations.setSourceLanguage, {
        documentId: args.documentId,
        sourceLanguageCode: transcript.sourceLanguageCode,
        sourceLanguageIsMixed: transcript.sourceLanguageIsMixed,
      });

      // Mirror the transcript into pages so text search and entity
      // extraction treat recordings like any other document.
      const transcriptText = segments
        .map((s) => `${s.speaker} [${Math.round(s.start)}s]: ${s.text}`)
        .join("\n\n");
      await ctx.runMutation(internal.ingest.ingestParseResults, {
        documentId: args.documentId,
        pageText: [transcriptText],
        blocks: [],
        pageDimensions: [],
        pageCount: 1,
      });

      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "transcribe",
        status: "completed",
      });

      // Embed the transcript page for semantic search (no-op without key)
      await ctx.scheduler.runAfter(0, internal.embeddings.embedDocument, {
        documentId: args.documentId,
      });

      // Recordings skip the metadata pass, so the transcript is the context
      // the rename pass gets to work from (convex/rename.ts).
      await ctx.scheduler.runAfter(0, internal.renameNode.runRenamePass, {
        documentId: args.documentId,
      });
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
        status: "parsed",
      });
      await scheduleTranslation(ctx, args.documentId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.processing.markFailed, {
        documentId: args.documentId,
        errorMessage: stageMessage("Transcription", e, msg),
        errorCode: failureCodeOf(e),
      });
    }
    return null;
  },
});


// ---------------------------------------------------------------------------
// Template-driven extraction: the confirmed template (roles + questions)
// compiles into the Interfaze JSON schema; results land as entities with
// per-document roles, resolved against the existing graph.
// ---------------------------------------------------------------------------

const roleValidator = v.object({
  role: v.string(),
  question: v.string(),
  entityType: v.string(),
});


const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");


export const runTemplateExtraction = internalAction({
  args: {
    documentId: v.id("documents"),
    roles: v.array(roleValidator),
    saveToKind: v.optional(v.string()), // kind name to save this template back to
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(
      (await import("./_generated/api")).api.documents.get,
      { id: args.documentId }
    );
    if (!document) throw new Error("Document not found");
    if (args.roles.length === 0) throw new Error("Template has no roles");

    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");

    const source = await extractionSource(ctx, document);

    if (args.saveToKind?.trim()) {
      await ctx.runMutation(api.kinds.saveTemplate, {
        name: args.saveToKind.trim().toLowerCase(),
        templateRoles: args.roles,
      });
    }

    // Compile the template into a JSON schema: one array property per role
    const properties: Record<string, unknown> = {};
    for (const r of args.roles) {
      properties[slug(r.role)] = {
        type: "array",
        items: { type: "string" },
        description: `${r.question} (list the ${r.entityType} names exactly as written)`,
      };
    }
    const pageSchema = { type: "object", properties, required: Object.keys(properties) };

    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "extracting",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "extract",
      status: "running",
    });
    await armWatchdog(ctx, args.documentId, "extract");

    try {
      const result = await extract(source, apiKey, pageSchema, {
        log: usageLogger(ctx, { documentId: args.documentId }),
      });

      await ctx.runMutation(internal.ingest.ingestTemplateResults, {
        documentId: args.documentId,
        roles: args.roles,
        schemaUsed: JSON.stringify(pageSchema),
        results: result.extraction_schema_json,
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

      // Map relationships between entities (non-fatal if it fails)
      await ctx.runAction(internal.relationshipsNode.extract, {
        documentId: args.documentId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.processing.markFailed, {
        documentId: args.documentId,
        errorMessage: stageMessage("Extract", e, msg),
        errorCode: failureCodeOf(e),
      });
    }
    return null;
  },
});

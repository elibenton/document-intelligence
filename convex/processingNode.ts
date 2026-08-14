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
import { internal } from "./_generated/api";
import {
  ocrDocument,
  analyzeDocumentText,
  transcribe,
  failureCodeOf,
} from "./interfaze";
import type { OcrPageResult } from "./interfaze";
import { checkGeometry } from "./ocrChecks";
import {
  analyzeSystemPrompt,
  buildAnalyzePrompt,
  buildDocumentUnderstandingSchema,
  type CategoryDef,
} from "./analyzePrompt";
import { usageLogger } from "./apiLogs";
import type { Doc, Id } from "./_generated/dataModel";
import Papa from "papaparse";

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
    const document = await ctx.runQuery(internal.documents.getInternal, {
      id: args.documentId,
    });
    if (!document) throw new Error("Document not found");

    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");
    const fileUrl = await requireFileUrl(ctx, document);
    const csv = isCsvDocument(document);
    const csvPages = csv ? await csvSearchPages(ctx, document) : null;
    const { kindNames, categories } = await projectTaxonomy(
      ctx,
      document.projectId
    );
    const log = usageLogger(ctx, { documentId: args.documentId });

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
      // --- Scan -------------------------------------------------------------
      // The dedicated OCR task, not a full model completion. The full model's
      // OCR precontext is non-deterministic on the same file — repeat runs
      // returned duplicate entries, a wrong entry count, and (in production)
      // every page collapsed onto page 1. The task returns one clean result per
      // document, every time, for ~1% of the cost. See docs/scan-precontext-plan.md.
      const parsedPages =
        csvPages ??
        (
          await ocrDocument(fileUrl, document.name, apiKey, {
            log,
            bypassCache: args.bypassCache,
            sizeBytes: document.sizeBytes,
          })
        ).pages;

      if (parsedPages.length === 0) {
        throw new Error(
          "Interfaze returned no OCR text for this document — it may be an image-only scan the OCR pass could not read"
        );
      }

      // A page left blank by a successful OCR is a defect, not a blank page:
      // it means pagination was misread and that page's text landed elsewhere.
      const blankPages = parsedPages.filter((page) => !page.text.trim());
      if (blankPages.length === parsedPages.length) {
        throw new Error(
          `OCR returned ${parsedPages.length} pages but no text on any of them`
        );
      }
      if (blankPages.length > 0) {
        console.warn(
          `Scan produced ${blankPages.length}/${parsedPages.length} pages with no text ` +
            `(pages ${blankPages.map((p) => p.pageNumber + 1).join(", ")}) — ` +
            `possible pagination misread`
        );
      }

      // Geometry is wrong by arithmetic or it is not wrong at all, so this
      // needs no reference output and runs on every scan. A violation here is
      // a viewer overlay that will land in the wrong place with no error
      // anywhere — the failure mode that is otherwise invisible until someone
      // notices a highlight over the wrong sentence.
      const geometry = checkGeometry(parsedPages);
      if (geometry.violations > 0) {
        console.error(
          `OCR geometry: ${geometry.violations} violations across ` +
            `${geometry.checked} blocks ` +
            `(${Object.entries(geometry.byKind)
              .map(([kind, n]) => `${kind}=${n}`)
              .join(", ")}) — ${geometry.examples.join("; ")}`
        );
      }

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

      // Scan is done and the document is searchable. Everything below can fail
      // without costing the user the text.
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
      // --- Analyze ----------------------------------------------------------
      // Text in, no file. Cheap, and an unchanged re-run hits the semantic
      // cache, which is what makes Analyze independently re-runnable.
      console.log(
        `Scan stored ${parsedPages.length} pages and ` +
          `${parsedPages.reduce((n, p) => n + p.blocks.length, 0)} blocks`
      );

      try {
        await analyzeAndStore(ctx, {
          documentId: args.documentId,
          pageTexts: parsedPages.map((page) => page.text),
          apiKey,
          csv,
          kindNames,
          categories,
          log,
          bypassCache: args.bypassCache,
          fileName: document.name,
        });
      } finally {
        // Translation is queued *after* Analyze, not before it.
        //
        // The skip gate in translationNode.ts can only recognize an
        // already-in-the-target-language document from `sourceLanguageCode` +
        // `sourceLanguageIsMixed`, and Analyze is what writes them. Queued
        // first, the gate saw `undefined`, declined to skip, and translated
        // English documents into English one page at a time: 101 of the first
        // 106 stored page translations were en→en.
        //
        // It stays in a `finally` because a document whose Analyze failed must
        // still get translated — it just gets translated without the hint, the
        // way every document used to.
        await scheduleTranslation(ctx, args.documentId);
      }
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

/**
 * The vocabulary Analyze is shown for one document: its project's categories
 * and the kinds that project has already named.
 *
 * A document outside any project gets neither. That is deliberate — the
 * alternative is showing it some other project's taxonomy, and both halves of
 * the prompt it feeds (the category enum, the kind-reuse clause) are claims
 * about what *this* corpus contains.
 */
async function projectTaxonomy(
  ctx: ActionCtx,
  projectId: Id<"projects"> | undefined
): Promise<{ kindNames: string[]; categories: Doc<"documentCategories">[] }> {
  if (!projectId) return { kindNames: [], categories: [] };
  const kinds: Doc<"documentKinds">[] = await ctx.runQuery(internal.kinds.listInternal, {
    projectId,
  });
  const categories: Doc<"documentCategories">[] = await ctx.runQuery(
    internal.documentCategories.listInternal,
    { projectId }
  );
  return { kindNames: kinds.map((kind) => kind.name), categories };
}

/**
 * Analyze: text in, structured metadata out. Shared by the upload pipeline and
 * by the standalone retry action below, so a re-run sends exactly what the
 * first run sent unless the user edited the prompt.
 */
async function analyzeAndStore(
  ctx: ActionCtx,
  options: {
    documentId: Id<"documents">;
    pageTexts: string[];
    apiKey: string;
    csv: boolean;
    kindNames: string[];
    categories: Doc<"documentCategories">[];
    log?: ReturnType<typeof usageLogger>;
    bypassCache?: boolean;
    promptOverride?: string;
    fileName?: string;
  }
): Promise<void> {
  const categoryDefs: CategoryDef[] = options.categories
    .sort((a, b) => a.order - b.order)
    .map((c) => ({ key: c.key, label: c.label, description: c.description }));
  const analysis = await analyzeDocumentText(options.pageTexts, options.apiKey, {
    log: options.log,
    bypassCache: options.bypassCache,
    systemPrompt: analyzeSystemPrompt(options.csv),
    prompt:
      options.promptOverride?.trim() ||
      buildAnalyzePrompt({
        csv: options.csv,
        kindNames: options.kindNames,
        categories: categoryDefs,
        fileName: options.fileName,
      }),
    responseSchema: {
      name: "document_analysis",
      schema: buildDocumentUnderstandingSchema(categoryDefs.map((c) => c.key)),
    },
  });

  await ctx.runMutation(internal.metadata.saveMetadataResult, {
    documentId: options.documentId,
    raw: analysis.content,
  });
  const structured = JSON.parse(analysis.content) as {
    source_language_code?: string;
    is_multilingual?: boolean;
  };
  if (structured.source_language_code) {
    await ctx.runMutation(internal.translations.setSourceLanguage, {
      documentId: options.documentId,
      sourceLanguageCode: structured.source_language_code,
      sourceLanguageIsMixed: structured.is_multilingual,
    });
  }
}

/**
 * Analyze on its own, over the stored page text — no re-scan.
 *
 * Retrying Analyze must never re-read the original file: extractions, entities,
 * and page geometry are all built on the stored scan, so replacing it behind
 * the user's back would invalidate them. A failure here fails only the analyze
 * job; the document keeps its scan and stays usable.
 */
export const runAnalyze = internalAction({
  args: {
    documentId: v.id("documents"),
    promptOverride: v.optional(v.string()),
    bypassCache: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(internal.documents.getInternal, {
      id: args.documentId,
    });
    if (!document) throw new Error("Document not found");

    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");

    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "analyze",
      status: "running",
    });

    try {
      const pages: { pageNumber: number; text: string }[] = await ctx.runQuery(
        internal.pages.textByDocument,
        { documentId: args.documentId }
      );
      const pageTexts = pages
        .sort((a, b) => a.pageNumber - b.pageNumber)
        .map((page) => page.text);
      if (pageTexts.length === 0 || pageTexts.every((text) => !text.trim())) {
        throw new Error(
          "No scanned text to analyze — run Scan before retrying Analyze"
        );
      }

      const { kindNames, categories } = await projectTaxonomy(
        ctx,
        document.projectId
      );
      await analyzeAndStore(ctx, {
        documentId: args.documentId,
        pageTexts,
        apiKey,
        csv: isCsvDocument(document),
        kindNames,
        categories,
        log: usageLogger(ctx, { documentId: args.documentId }),
        // An unchanged prompt would only hit the semantic cache, which is the
        // whole reason the dialog invites an edit. Honor whatever it produced.
        bypassCache: args.bypassCache,
        promptOverride: args.promptOverride,
        fileName: document.name,
      });

      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "analyze",
        status: "completed",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.processing.markStageFailed, {
        documentId: args.documentId,
        stage: "analyze",
        errorMessage: stageMessage("Analyze", e, msg),
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




// ---------------------------------------------------------------------------
// Transcribe — audio/video → diarized transcript with word timestamps.
// The transcript text is also ingested as a single "page" so search and
// entity extraction work on recordings the same way they do on documents.
// ---------------------------------------------------------------------------

export const runTranscribe = internalAction({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(internal.documents.getInternal, {
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




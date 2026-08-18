/**
 * Document pipeline — the stage actions (parse/OCR, analyze, transcribe).
 * The queueing, pause gate and status mutations they run against live in
 * processing.ts and are reached by function reference.
 */

import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  ocrDocument,
  analyzeDocumentText,
  transcribe,
  understandDocument,
  ocrPrecontextToPages,
  chunksToSegments,
  failureCodeOf,
} from "./interfaze";
import type { OcrPageResult, Precontext } from "./interfaze";
import type { SttTaskResult } from "./interfazeStt";
import { normalizeGraphResponse } from "./relationships";
import type { GraphResponse } from "./relationships";
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
    // Resolved from the document rather than from a deployment-wide row: the
    // target language belongs to whoever owns it, and the scheduler this runs
    // under carries no identity to ask.
    const translationSettings: {
      defaultLanguageCode: string;
      translationVersion: number;
    } = await ctx.runQuery(internal.settings.forDocumentInternal, {
      documentId,
    });
    await ctx.scheduler.runAfter(0, internal.translations.translateDocument, {
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
 * Queue Analyze as its own stage instead of running it inline.
 *
 * Analyze is roughly eleven times Scan (`analyze` p50 22.6s against `ocr` p50
 * 2.0s), and awaiting it here kept this action alive for that whole time —
 * *after* this stage's own job row had already been marked completed. A bulk
 * upload queued every other document's two-second Scan behind a full
 * Scan+Analyze cycle. Splitting the stages makes the job row's lifetime equal
 * the action's lifetime.
 */
async function enqueueAnalyze(
  ctx: ActionCtx,
  documentId: Id<"documents">,
  bypassCache?: boolean
): Promise<void> {
  // enqueueStage dedupes: an already queued or running Analyze owns the
  // stage, including the translation it schedules on the way out.
  await ctx.runMutation(internal.processing.enqueue, {
    documentId,
    stage: "analyze",
    ...(bypassCache === undefined ? {} : { bypassCache }),
  });
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
    if (
      await ctx.runMutation(internal.processing.bailIfPaused, {
        documentId: args.documentId,
        stage: "parse",
      })
    )
      return null;
    const document = await ctx.runQuery(internal.documents.getInternal, {
      id: args.documentId,
    });
    if (!document) throw new Error("Document not found");

    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");
    const fileUrl = await requireFileUrl(ctx, document);
    const csvPages = isCsvDocument(document)
      ? await csvSearchPages(ctx, document)
      : null;
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

      // Enqueued rather than awaited — see enqueueAnalyze. Translation is
      // queued by that stage on its way out, not here: the skip gate in
      // translationNode.ts recognizes an already-in-the-target-language
      // document from `sourceLanguageCode` + `sourceLanguageIsMixed`, and
      // Analyze is what writes them. Queued before Analyze the gate saw
      // `undefined`, declined to skip, and translated English documents into
      // English one page at a time: 101 of the first 106 stored page
      // translations were en→en.
      await enqueueAnalyze(ctx, args.documentId, args.bypassCache);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.processing.markFailed, {
        documentId: args.documentId,
        errorMessage: stageMessage("Document understanding", error, message),
        errorCode: failureCodeOf(error),
        stage: "parse",
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
    if (
      await ctx.runMutation(internal.processing.bailIfPaused, {
        documentId: args.documentId,
        stage: "analyze",
      })
    )
      return null;
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
    } finally {
      // Queued here rather than by the Scan that enqueued this stage, because
      // the skip gate needs `sourceLanguageCode` + `sourceLanguageIsMixed` and
      // Analyze is what writes them.
      //
      // In a `finally` because a document whose Analyze failed must still get
      // translated — it just gets translated without the hint, the way every
      // document used to. Re-running Analyze re-queues it harmlessly:
      // translations.beginTranslation returns false for a lifecycle that has
      // already started, so a repeat is one query and an early return.
      await scheduleTranslation(ctx, args.documentId);
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
    if (
      await ctx.runMutation(internal.processing.bailIfPaused, {
        documentId: args.documentId,
        stage: "transcribe",
      })
    )
      return null;
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

      // Mirror the transcript into pages so text search and entity
      // extraction treat recordings like any other document.
      //
      // One block per speaker turn, not zero. relationships.ingestGraph derives
      // every mention by substring-matching an entity's name against block
      // text, so `blocks: []` meant a recording could resolve entities and
      // relationships and still show an empty entity sidebar — mentions is what
      // entities.byDocument reads, and what recountEntity counts. Page numbers
      // here are 0-based: ingest groups incoming blocks by the same index it
      // walks pages with, and a single-page document is page 0.
      const transcriptText = segments
        .map((s) => `${s.speaker} [${Math.round(s.start)}s]: ${s.text}`)
        .join("\n\n");
      await ctx.runMutation(internal.ingest.ingestParseResults, {
        documentId: args.documentId,
        pageText: [transcriptText],
        blocks: segments.map((s, i) => ({
          blockId: `transcript_seg${i}`,
          blockType: "Text",
          text: s.text,
          pageNumber: 0,
        })),
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
      await ctx.scheduler.runAfter(0, internal.rename.runRenamePass, {
        documentId: args.documentId,
      });
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
        status: "parsed",
      });

      // A recording joins the document pipeline here rather than ending at a
      // standalone rename. Analyze reads page text, not the file, so the
      // transcript mirrored above is all it needs — and it supersedes the
      // rename pass outright: `display_title` is written by the same response
      // that just derived the document's kind, which is why the title got
      // better when it moved onto Analyze.
      //
      // This is also what schedules everything downstream. Analyze's
      // saveMetadataResult enqueues the entity/relationship pass, and Analyze's
      // own `finally` owns the translation this stage used to queue directly —
      // the skip gate there needs the language fields Analyze writes, so
      // queueing translation from here raced it with no hint.
      await enqueueAnalyze(ctx, args.documentId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.processing.markFailed, {
        documentId: args.documentId,
        errorMessage: stageMessage("Transcription", e, msg),
        errorCode: failureCodeOf(e),
        stage: "transcribe",
      });
    }
    return null;
  },
});


// ---------------------------------------------------------------------------
// The merged pipeline: one full-model call per document.
//
// Structured analysis (metadata + title + language + entity graph) arrives on
// `content`; the specialist output (OCR geometry for documents, the transcript
// for recordings) is expected on `precontext` per the provider's docs. As of
// 2026-08-18 precontext comes back empty on every full-model call — reported
// to Interfaze as a bug — so the geometry is shimmed from the dedicated task
// at exactly one seam below. The shim's task call logs its own apiLogs row,
// which is how we will see the day their fix lands: the `ocr`/`transcribe`
// rows disappear and only `understand` remains.
// ---------------------------------------------------------------------------

/** Read the specialist entry off precontext, if the provider sent one. */
function precontextResult<T>(precontext: Precontext[], name: string): T | undefined {
  const entry = precontext.find((p) => p.name === name);
  return entry?.result as T | undefined;
}

export const runPipeline = internalAction({
  args: {
    documentId: v.id("documents"),
    bypassCache: v.optional(v.boolean()),
    promptOverride: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      await ctx.runMutation(internal.processing.bailIfPaused, {
        documentId: args.documentId,
        stage: "parse",
      })
    )
      return null;
    const document = await ctx.runQuery(internal.documents.getInternal, {
      id: args.documentId,
    });
    if (!document) throw new Error("Document not found");
    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");
    const fileUrl = await requireFileUrl(ctx, document);
    const log = usageLogger(ctx, { documentId: args.documentId });
    const isRecording =
      document.mediaType === "audio" || document.mediaType === "video";
    const csv = isCsvDocument(document);

    await ctx.runMutation(internal.processing.updateStatus, {
      documentId: args.documentId,
      status: "parsing",
    });
    await ctx.runMutation(internal.processing.updateJobStatus, {
      documentId: args.documentId,
      stage: "parse",
      status: "running",
    });

    // Everything up to the text being stored fails the document; everything
    // after it fails softly, because the user already has a searchable scan.
    let textStored = false;
    try {
      const { kindNames, categories } = await projectTaxonomy(
        ctx,
        document.projectId
      );
      const categoryDefs: CategoryDef[] = categories
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ key: c.key, label: c.label, description: c.description }));
      const extraTypes: { key: string; label: string; description: string }[] =
        document.projectId
          ? await ctx.runQuery(internal.projectEntityTypes.listInternal, {
              projectId: document.projectId,
            })
          : [];

      // --- The one call ----------------------------------------------------
      const result = await understandDocument(fileUrl, document.name, apiKey, {
        systemPrompt: analyzeSystemPrompt(csv),
        prompt:
          args.promptOverride?.trim() ||
          buildAnalyzePrompt({
            csv,
            kindNames,
            categories: categoryDefs,
            fileName: document.name,
            graphExtraTypes: extraTypes,
            fileInput: true,
          }),
        responseSchema: {
          name: "document_understanding",
          schema: buildDocumentUnderstandingSchema(
            categoryDefs.map((c) => c.key),
            extraTypes.map((t) => t.key)
          ),
        },
        log,
        bypassCache: args.bypassCache,
        sizeBytes: document.sizeBytes,
      });

      // --- Text + geometry: precontext, or the task-call shim --------------
      let parsedPages: OcrPageResult[];
      let transcriptSegments: ReturnType<typeof chunksToSegments> | null = null;
      if (isRecording) {
        const stt = precontextResult<SttTaskResult>(
          result.precontext,
          "speech_to_text"
        ) ?? precontextResult<SttTaskResult>(result.precontext, "stt");
        const segments = stt ? chunksToSegments(stt.chunks ?? []) : [];
        transcriptSegments =
          segments.length > 0
            ? segments
            : (await transcribe(fileUrl, apiKey, log)).segments;
        const transcriptText = transcriptSegments
          .map((s) => `${s.speaker} [${Math.round(s.start)}s]: ${s.text}`)
          .join("\n\n");
        parsedPages = [
          {
            pageNumber: 0,
            text: transcriptText,
            blocks: transcriptSegments.map((s, i) => ({
              id: `transcript_seg${i}`,
              block_type: "Text",
              text: s.text,
              page: 0,
            })),
          },
        ];
      } else if (csv) {
        parsedPages = await csvSearchPages(ctx, document);
      } else {
        const fromPrecontext = ocrPrecontextToPages(
          result.precontext.filter((p) => p.name === "ocr")
        );
        parsedPages =
          fromPrecontext.length > 0
            ? fromPrecontext
            : (
                await ocrDocument(fileUrl, document.name, apiKey, {
                  log,
                  bypassCache: args.bypassCache,
                  sizeBytes: document.sizeBytes,
                })
              ).pages;
      }

      if (parsedPages.length === 0) {
        throw new Error(
          "Interfaze returned no text for this document — it may be an image-only scan the OCR pass could not read"
        );
      }
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

      if (transcriptSegments) {
        await ctx.runMutation(internal.transcripts.ingestTranscript, {
          documentId: args.documentId,
          segments: transcriptSegments,
        });
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
      textStored = true;
      console.log(
        `Pipeline stored ${parsedPages.length} pages and ` +
          `${parsedPages.reduce((n, p) => n + p.blocks.length, 0)} blocks`
      );
      await ctx.scheduler.runAfter(0, internal.embeddings.embedDocument, {
        documentId: args.documentId,
      });
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
        status: "parsed",
      });

      // --- Metadata + graph, off the same response -------------------------
      await ctx.runMutation(internal.metadata.saveMetadataResult, {
        documentId: args.documentId,
        raw: result.content,
        skipRelationships: true,
      });
      const structured = JSON.parse(result.content) as GraphResponse & {
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
      const graph = normalizeGraphResponse(structured);
      if (graph.unlisted > 0) {
        console.warn(
          `${graph.unlisted} relationship(s) named entities missing from the entity list for ${args.documentId}`
        );
      }
      await ctx.runMutation(internal.relationships.ingestGraph, {
        documentId: args.documentId,
        entities: graph.entities,
        relationships: graph.relationships,
      });

      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "parse",
        status: "completed",
      });
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
        status: "completed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (textStored) {
        // The scan is stored and searchable; only the enrichment failed.
        await ctx.runMutation(internal.processing.markStageFailed, {
          documentId: args.documentId,
          stage: "parse",
          errorMessage: stageMessage("Understanding", error, message),
        });
      } else {
        await ctx.runMutation(internal.processing.markFailed, {
          documentId: args.documentId,
          errorMessage: stageMessage("Document understanding", error, message),
          errorCode: failureCodeOf(error),
          stage: "parse",
        });
      }
    } finally {
      // Translation is derived and survives an enrichment failure; the skip
      // gate reads the language fields written above when they exist.
      if (textStored) await scheduleTranslation(ctx, args.documentId);
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Template-driven extraction: the confirmed template (roles + questions)
// compiles into the Interfaze JSON schema; results land as entities with
// per-document roles, resolved against the existing graph.
// ---------------------------------------------------------------------------




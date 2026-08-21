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
import {
  analyzeSystemPrompt,
  buildAnalyzePrompt,
  buildDocumentUnderstandingSchema,
  type CategoryDef,
  type NativeMetadataOmissions,
} from "./analyzePrompt";
import { usageLogger } from "./apiLogs";
import { isCsvDocument, isRecordingDocument } from "./mediaTypes";
import type { Doc, Id } from "./_generated/dataModel";
import Papa from "papaparse";

const CSV_INDEX_BYTES = 700_000;
const CSV_INDEX_ROWS = 2_000;
const CSV_ROWS_PER_PAGE = 100;

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
 * Stage-prefix a failure message — except for classified provider failures,
 * whose message already names the cause and the fix in the user's terms.
 * "Parse failed: Interfaze API credits exhausted — add credits…" buries the
 * only part the reader can act on behind a stage label they don't need.
 */
function stageMessage(stage: string, e: unknown, msg: string): string {
  return failureCodeOf(e) ? msg : `${stage} failed: ${msg}`;
}



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
 * Build the understanding request — system prompt, user prompt, and schema —
 * for either input shape. One home, so the file-in and text-in calls cannot
 * drift: the only branch is `fileInput`, which changes the prompt's lead
 * sentence and nothing else.
 */
async function understandingRequest(
  ctx: ActionCtx,
  options: {
    projectId: Id<"projects"> | undefined;
    csv: boolean;
    kindNames: string[];
    categories: Doc<"documentCategories">[];
    fileName?: string;
    promptOverride?: string;
    fileInput?: boolean;
    /** Recording rather than paged document: the table of contents is asked
     *  for by start time in seconds instead of page number. */
    audio?: boolean;
    /** What the file/source itself declared (documents.sourceMetadata). Fields
     * it covers are removed from the request — ground truth over inference;
     * saveMetadataResult reads them back in when persisting. */
    sourceMetadata?: Doc<"documents">["sourceMetadata"];
    /** Web clips: a scraped page's nav chrome makes the outline noise, so the
     * table of contents leaves the request entirely — fewer billed output
     * tokens, and the Contents tab falls back to the block list. */
    omitTableOfContents?: boolean;
    /** Web clips whose page stated no published date: ask the model for a
     * conservative created_date. Everything else never asks — native or
     * nothing — which keeps non-clip request bytes vcache-identical. */
    askCreatedDate?: boolean;
  }
): Promise<{
  systemPrompt: string;
  prompt: string;
  responseSchema: { name: string; schema: Record<string, unknown> };
}> {
  const categoryDefs: CategoryDef[] = options.categories
    .sort((a, b) => a.order - b.order)
    .map((c) => ({ key: c.key, label: c.label, description: c.description }));
  const extraTypes: { key: string; label: string; description: string }[] =
    options.projectId
      ? await ctx.runQuery(internal.projectEntityTypes.listInternal, {
          projectId: options.projectId,
        })
      : [];
  const omit: NativeMetadataOmissions | undefined =
    (options.sourceMetadata || options.omitTableOfContents) && !options.csv
      ? {
          tableOfContents:
            !!options.omitTableOfContents ||
            !!options.sourceMetadata?.tableOfContents?.length,
          displayTitle: !!options.sourceMetadata?.title,
          author: !!options.sourceMetadata?.author,
        }
      : undefined;
  return {
    systemPrompt: analyzeSystemPrompt(options.csv),
    prompt:
      options.promptOverride?.trim() ||
      buildAnalyzePrompt({
        csv: options.csv,
        kindNames: options.kindNames,
        categories: categoryDefs,
        fileName: options.fileName,
        graphExtraTypes: extraTypes,
        fileInput: options.fileInput,
        audio: options.audio,
        omit,
        askCreatedDate: options.askCreatedDate,
      }),
    responseSchema: {
      name: "document_understanding",
      schema: buildDocumentUnderstandingSchema(
        categoryDefs.map((c) => c.key),
        extraTypes.map((t) => t.key),
        omit,
        options.audio,
        options.askCreatedDate
      ),
    },
  };
}

/**
 * Persist one understanding response: metadata, language, and the entity
 * graph. The single home for what a response *means* — the file-in pipeline
 * and the text-in analyze both end here, so a field added to the response
 * lands in every path or none.
 *
 * Parsed once, up front, and a throw here happens *before* any mutation:
 * a truncated response fails whole rather than half-persisting metadata
 * before dying on the graph.
 */
async function persistUnderstanding(
  ctx: ActionCtx,
  documentId: Id<"documents">,
  content: string
): Promise<void> {
  const structured = JSON.parse(content) as GraphResponse & {
    source_language_code?: string;
    is_multilingual?: boolean;
  };
  await ctx.runMutation(internal.metadata.saveMetadataResult, {
    documentId,
    raw: content,
  });
  if (structured.source_language_code) {
    await ctx.runMutation(internal.translations.setSourceLanguage, {
      documentId,
      sourceLanguageCode: structured.source_language_code,
      sourceLanguageIsMixed: structured.is_multilingual,
    });
  }
  const graph = normalizeGraphResponse(structured);
  if (graph.unlisted > 0) {
    console.warn(
      `${graph.unlisted} relationship(s) named entities missing from the entity list for ${documentId}`
    );
  }
  await ctx.runMutation(internal.relationships.ingestGraph, {
    documentId,
    entities: graph.entities,
    relationships: graph.relationships,
  });
  await ctx.runMutation(internal.metadata.setSuggestedEntityTypes, {
    documentId,
    suggestions: graph.suggestions,
  });
}

/**
 * Analyze: text in, structured metadata out. Shared by clips and by the
 * standalone retry action below, so a re-run sends exactly what the first run
 * sent unless the user edited the prompt.
 */
async function analyzeAndStore(
  ctx: ActionCtx,
  options: {
    documentId: Id<"documents">;
    projectId: Id<"projects"> | undefined;
    pageTexts: string[];
    apiKey: string;
    csv: boolean;
    audio?: boolean;
    kindNames: string[];
    categories: Doc<"documentCategories">[];
    log?: ReturnType<typeof usageLogger>;
    bypassCache?: boolean;
    promptOverride?: string;
    fileName?: string;
    sourceMetadata?: Doc<"documents">["sourceMetadata"];
    omitTableOfContents?: boolean;
    askCreatedDate?: boolean;
  }
): Promise<void> {
  const request = await understandingRequest(ctx, options);
  const analysis = await analyzeDocumentText(options.pageTexts, options.apiKey, {
    log: options.log,
    bypassCache: options.bypassCache,
    ...request,
  });
  await persistUnderstanding(ctx, options.documentId, analysis.content);
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
        projectId: document.projectId,
        pageTexts,
        apiKey,
        csv: isCsvDocument(document),
        // The stored transcript text carries [Ns] timestamps, so a text-in
        // re-analyze of a recording can still produce a timed TOC.
        audio:
          document.mediaType === "audio" || document.mediaType === "video",
        kindNames,
        categories,
        log: usageLogger(ctx, { documentId: args.documentId }),
        // An unchanged prompt would only hit the semantic cache, which is the
        // whole reason the dialog invites an edit. Honor whatever it produced.
        bypassCache: args.bypassCache,
        promptOverride: args.promptOverride,
        fileName: document.name,
        sourceMetadata: document.sourceMetadata,
        omitTableOfContents: document.mediaType === "webScrape",
        askCreatedDate:
          document.mediaType === "webScrape" &&
          !document.sourceMetadata?.createdDate,
      });

      await ctx.runMutation(internal.processing.updateJobStatus, {
        documentId: args.documentId,
        stage: "analyze",
        status: "completed",
      });
      // The graph rode along, so this call is the whole enrichment.
      await ctx.runMutation(internal.processing.updateStatus, {
        documentId: args.documentId,
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
    const isRecording = isRecordingDocument(document);
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

      // --- Digital-native fast path ----------------------------------------
      // The browser committed this PDF's own text layer before parse was
      // enqueued (convex/nativeText.ts), so there is nothing to OCR: no file
      // leaves storage, and understanding rides the same text-in call an
      // Analyze retry uses — measured ~5x cheaper than the file-in completion
      // (see the cost note on understandDocument). The gate requires the
      // layer to be complete and trustworthy; anything less falls through to
      // the file-in call below and the per-page merge in ingest.ts.
      if (document.mediaType === "pdf") {
        const nativePages: { pageNumber: number; text: string }[] | null =
          await ctx.runQuery(internal.nativeText.completeNativePages, {
            documentId: args.documentId,
          });
        if (nativePages) {
          textStored = true;
          await ctx.scheduler.runAfter(0, internal.embeddings.embedDocument, {
            documentId: args.documentId,
          });
          await ctx.runMutation(internal.processing.updateStatus, {
            documentId: args.documentId,
            status: "parsed",
          });
          await analyzeAndStore(ctx, {
            documentId: args.documentId,
            projectId: document.projectId,
            pageTexts: nativePages.map((page) => page.text),
            apiKey,
            csv: false,
            kindNames,
            categories,
            log,
            bypassCache: args.bypassCache,
            fileName: document.name,
            sourceMetadata: document.sourceMetadata,
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
          return null;
        }
      }

      // --- The one call ----------------------------------------------------
      const result = await understandDocument(fileUrl, document.name, apiKey, {
        ...(await understandingRequest(ctx, {
          projectId: document.projectId,
          csv,
          kindNames,
          categories,
          fileName: document.name,
          fileInput: true,
          audio: isRecording,
          // A partially-native PDF still preempts the fields its own file
          // metadata answers, even though the text goes through OCR.
          sourceMetadata: document.sourceMetadata,
          omitTableOfContents: document.mediaType === "webScrape",
          askCreatedDate:
            document.mediaType === "webScrape" &&
            !document.sourceMetadata?.createdDate,
        })),
        log,
        bypassCache: args.bypassCache,
      });

      // --- Text + geometry: precontext, or the task-call shim --------------
      let parsedPages: OcrPageResult[];
      let transcriptSegments: ReturnType<typeof chunksToSegments> | null = null;
      if (isRecording) {
        const stt = precontextResult<SttTaskResult>(
          result.precontext,
          "speech_to_text"
        ) ?? // The provider's docs name this entry "stt" in their own example
          // while the task is "speech_to_text" — accept both spellings.
          precontextResult<SttTaskResult>(result.precontext, "stt");
        // Measured 2026-08-18: the merged call's STT precontext arrives without
        // per-chunk speaker labels, so an hour of interview collapsed into one
        // "Speaker 1" segment. Diarization is the transcript UI's structure —
        // trust precontext only when it actually carries speakers, else pay for
        // the task call, which does.
        const diarized = stt?.chunks?.some((c) => c.speaker) ?? false;
        const segments = stt && diarized ? chunksToSegments(stt.chunks ?? []) : [];
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
      // Geometry is not re-checked here: both sources of pages run
      // checkGeometry at their own call's quality hook, so the rate lands on
      // the apiLogs row that produced the pages.

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
      await persistUnderstanding(ctx, args.documentId, result.content);

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




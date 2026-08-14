"use node";

/**
 * Interfaze client for Convex actions — built on the official `interfaze` SDK
 * (https://interfaze.ai/docs), a typed wrapper over the OpenAI Chat Completions
 * shape. A single completion returns both the model's answer and a `precontext`
 * array carrying the raw specialist metadata (for documents: OCR sections →
 * lines → words with bounding boxes and confidence).
 *
 * New document uploads run the dedicated `ocr` task rather than a full-model
 * completion: it is deterministic where the full model was not, and about a
 * tenth of the cost. Its OCR precontext becomes the app's stored page text,
 * line/word blocks, boxes, and confidence; the structured understanding is a
 * second, text-in call (`analyzeDocumentText`) over that stored text.
 *
 * This module keeps a small set of app-facing helpers (`chatCompletion`,
 * `ocrDocument`, `analyzeDocumentText`, `extract`, and `transcribe`) so the
 * cross-cutting concerns the app owns — usage/cost logging and mapping the
 * SDK's typed errors onto the UI's FailureCodes — live in one place. Everything
 * else is the SDK.
 */

import {
  Interfaze,
  responseFormat,
  inputs,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "interfaze";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  Precontext,
  ReasoningEffort,
  TaskName,
} from "interfaze";

import { fnv1a } from "./hash";
import { InterfazeFailure } from "./interfazeErrors";
import { PROVIDER_FILE_OBJECT_SAFE_BYTES } from "./interfazeLimits";
import { interfazeCostUsd } from "./interfazeCost";
import type { UsageLogger } from "./interfazeCost";
import { ocrPrecontextToPages } from "./interfazeOcr";
import type { OcrPageResult } from "./interfazeOcr";

// Re-exported so every existing `from "./interfaze"` import keeps working —
// callers should not have to know which of these modules a symbol lives in.
export * from "./interfazeCost";
export * from "./interfazeErrors";
export * from "./interfazeOcr";

const INTERFAZE_MODEL = "interfaze-beta";

// Convex kills actions at 10 minutes without running catch blocks, which would
// strand documents in "parsing"/"extracting". Time the request out first so
// the action's own error handling can mark the job failed. (Interfaze itself
// caps a request at 5 minutes; this is the outer Convex-facing guard.)
const INTERFAZE_TIMEOUT_MS = 9 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


export interface ExtractResult {
  extraction_schema_json: string; // JSON string of extracted data
}

export interface ChatResult {
  content: string;
  precontext: Precontext[];
  /** True when Interfaze served this completion from its vcache. */
  vcache: boolean;
  /** Output tokens billed — an empty `content` alongside a non-zero count is
   *  a provider failure, not an empty document. */
  completionTokens: number;
}

export interface TranslationUnit {
  id: string;
  text: string;
}

export interface TranslationResult {
  sourceLanguageCode: string;
  translations: TranslationUnit[];
}



/**
 * Turn a caught SDK error into a classified InterfazeFailure. The SDK re-exports
 * OpenAI's typed error classes carrying `status`/`code`; classify on those. An
 * exhausted balance surfaces as a 403 permission error whose code/message names
 * quota or credits, so check that before the generic cases.
 */
function classifyError(e: unknown): InterfazeFailure {
  if (e instanceof InterfazeFailure) return e;

  if (e instanceof APIConnectionTimeoutError || e instanceof APIUserAbortError) {
    return new InterfazeFailure(
      `Interfaze request timed out after ${Math.round(
        INTERFAZE_TIMEOUT_MS / 60000
      )} minutes — the document may be too large to process in one pass`,
      { code: "timeout" }
    );
  }

  if (e instanceof APIError) {
    const status = e.status;
    const providerCode =
      typeof e.code === "string" ? e.code.toLowerCase() : "";
    const haystack = `${providerCode} ${e.message ?? ""}`.toLowerCase();

    if (
      providerCode === "insufficient_quota" ||
      /no credits|insufficient (quota|credit|funds)|out of credits|billing/.test(
        haystack
      )
    ) {
      return new InterfazeFailure(
        "Interfaze API credits exhausted — add credits at interfaze.ai to resume processing.",
        { code: "insufficient_credits", status }
      );
    }
    if (e instanceof AuthenticationError) {
      return new InterfazeFailure(
        "Interfaze rejected the API key — check INTERFAZE_API_KEY in the Convex deployment.",
        { code: "invalid_api_key", status }
      );
    }
    if (e instanceof RateLimitError) {
      return new InterfazeFailure(
        "Interfaze rate limit hit — processing will retry shortly.",
        { code: "rate_limited", status }
      );
    }
    if (e instanceof PermissionDeniedError) {
      return new InterfazeFailure(
        "Interfaze rejected the API key — check INTERFAZE_API_KEY in the Convex deployment.",
        { code: "invalid_api_key", status }
      );
    }
    const detail = (e.message ?? "").slice(0, 300);
    return new InterfazeFailure(
      `Interfaze API error (${status})${detail ? `: ${detail}` : ""}`,
      { status }
    );
  }

  return new InterfazeFailure(e instanceof Error ? e.message : String(e));
}

// ---------------------------------------------------------------------------
// Content-part helpers — thin wrappers over the SDK's `inputs.*` builders.
// ---------------------------------------------------------------------------

/**
 * Reference a document by URL as a `file` content part. Interfaze fetches it at
 * inference time; a stable URL (same bytes → same URL) is also the cache key,
 * so repeat calls against the same file hit the cache.
 *
 * Pass documents/images through the `file` part (not as a bare URL in text): a
 * URL in text gets the OCR text into context but loses visual grounding —
 * A/B tested, the visual-evidence pass confabulated logos/seals with text URLs
 * and was clean with file objects. It also measured 11x the cost for identical
 * OCR results, so the file part stays the default for everything that fits.
 *
 * A file part is capped at 20 MB and prompt text at 80 MB, so above the smaller
 * ceiling there is no choice: send the URL as text and accept both costs. That
 * is strictly better than the alternative it replaced, which was refusing the
 * document at upload. `sizeBytes` is optional because rows predating
 * `documents.sizeBytes` have none — and every one of those passed the old
 * 18 MB gate, so defaulting them to the file part is correct.
 */
export function fileUrlContent(
  url: string,
  filename = "document.pdf",
  sizeBytes?: number
): ChatCompletionContentPart {
  if (sizeBytes !== undefined && sizeBytes > PROVIDER_FILE_OBJECT_SAFE_BYTES) {
    return { type: "text", text: `The document to work on is at this URL: ${url}` };
  }
  return inputs.file(url, { filename });
}

/**
 * Inline a text document's content directly in the prompt. Used for web clips:
 * Interfaze's file specialists fetch PDFs/images by URL, but a bare URL to a
 * text file is not reliably fetched — inlining the (small) text is
 * deterministic. Capped to stay within prompt limits.
 */
// Interfaze caps a single inline text input at 250,000 bytes
// (`LIMITS.maxInlineTextBytesPerFile`). Stay under it in *bytes*, not
// characters — accented and non-Latin text runs two to three bytes per
// character, so a character-based cap silently overshoots on exactly the
// documents most likely to be long.
const MAX_INLINE_TEXT_BYTES = 240_000;

export function inlineTextContent(text: string): ChatCompletionContentPart {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let clipped = text;

  if (bytes.byteLength > MAX_INLINE_TEXT_BYTES) {
    // Decode a byte-truncated slice with the default (lenient) decoder so a
    // split multi-byte character is dropped rather than corrupted.
    clipped =
      new TextDecoder().decode(bytes.slice(0, MAX_INLINE_TEXT_BYTES)) +
      "\n\n[truncated]";
    // Truncation is a silent correctness loss — an extraction simply will not
    // see the tail of the document — so it must be visible in the logs.
    console.warn(
      `Inline text truncated to ${MAX_INLINE_TEXT_BYTES} bytes ` +
        `(dropped ${bytes.byteLength - MAX_INLINE_TEXT_BYTES} bytes, ` +
        `~${Math.round((1 - MAX_INLINE_TEXT_BYTES / bytes.byteLength) * 100)}% of the document)`
    );
  }
  return { type: "text", text: `Document content:\n\n${clipped}` };
}

// ---------------------------------------------------------------------------
// Core chat completion call — one place for the client, usage logging, and
// error classification. Everything else in this file goes through it.
// ---------------------------------------------------------------------------

export async function chatCompletion(
  apiKey: string,
  options: {
    content: ChatCompletionContentPart[];
    systemPrompt?: string;
    responseSchema?: { name: string; schema: Record<string, unknown> };
    maxTokens?: number;
    /** Enable reasoning for inference-heavy calls (relationship mapping,
     * grounded search answers) — off for straight extraction. */
    reasoning?: boolean;
    /** When set, token usage + cost for this call is reported to the log. */
    usage?: { log: UsageLogger; operation: string };
    /** Force a fresh provider run for an operator-requested retry. */
    bypassCache?: boolean;
    /**
     * Run a single built-in specialist instead of the whole model. Cannot be
     * combined with `responseSchema` — the SDK throws on that pairing.
     */
    task?: TaskName;
  }
): Promise<ChatResult> {
  const startedAt = Date.now();
  // Cohort key. Deliberately covers only the *shape* of the request — system
  // prompt, schema, task — and never the document text, so every call sharing
  // a prompt version groups together and a regression is attributable to the
  // change that caused it.
  const promptHash = fnv1a(
    [
      options.usage?.operation ?? "",
      options.task ?? "",
      options.systemPrompt ?? "",
      options.responseSchema
        ? options.responseSchema.name +
          JSON.stringify(options.responseSchema.schema)
        : "",
    ].join("\0")
  );
  const reportUsage = async (report: {
    status: "ok" | "error";
    promptTokens?: number;
    completionTokens?: number;
    cacheHit?: boolean;
    error?: string;
    finishReason?: string;
    outputHash?: string;
    errorCode?: string;
  }) => {
    if (!options.usage) return;
    const promptTokens = report.promptTokens ?? 0;
    const completionTokens = report.completionTokens ?? 0;
    await options.usage.log({
      provider: "interfaze",
      operation: options.usage.operation,
      model: INTERFAZE_MODEL,
      status: report.status,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: interfazeCostUsd(
        promptTokens,
        completionTokens,
        report.cacheHit
      ),
      durationMs: Date.now() - startedAt,
      cacheHit: report.cacheHit,
      error: report.error,
      finishReason: report.finishReason,
      promptHash,
      outputHash: report.outputHash,
      errorCode: report.errorCode,
      buildSha: process.env.BUILD_SHA?.slice(0, 7),
    });
  };

  const interfaze = new Interfaze({
    apiKey,
    timeout: INTERFAZE_TIMEOUT_MS,
    maxRetries: 2,
    bypassCache: options.bypassCache,
  });

  const messages: ChatCompletionMessageParam[] = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: options.content });

  try {
    const res = await interfaze.chat.completions.create({
      messages,
      ...(options.task ? { task: options.task } : {}),
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.reasoning
        ? { reasoning_effort: "high" as ReasoningEffort }
        : {}),
      ...(options.responseSchema
        ? {
            response_format: responseFormat(
              options.responseSchema.schema,
              options.responseSchema.name
            ),
          }
        : {}),
    });

    const content = res.choices?.[0]?.message?.content ?? "";
    await reportUsage({
      status: "ok",
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
      cacheHit: res.vcache,
      // "length" means the provider stopped early. We pay for the emitted
      // tokens either way and get unparseable JSON back, so this is the one
      // quality signal that is free, self-evident, and currently unmeasured.
      finishReason: res.choices?.[0]?.finish_reason ?? undefined,
      outputHash: fnv1a(content.trim()),
    });
    return {
      content,
      precontext: res.precontext ?? [],
      vcache: res.vcache,
      completionTokens: res.usage?.completion_tokens ?? 0,
    };
  } catch (e) {
    const failure = classifyError(e);
    await reportUsage({
      status: "error",
      error: failure.message,
      errorCode: failure.code,
    });
    throw failure;
  }
}

// ---------------------------------------------------------------------------
// Translate — stable-ID structured batches. The input JSON is serialized in a
// deterministic order so identical retries remain eligible for Interfaze's
// vcache. IDs are validated on return before anything is persisted.
// ---------------------------------------------------------------------------

const TRANSLATION_SCHEMA = {
  type: "object",
  properties: {
    detected_source_language_code: {
      type: "string",
      description: "Primary source language as a lowercase ISO 639 code",
    },
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
        },
        required: ["id", "text"],
      },
    },
  },
  required: ["detected_source_language_code", "translations"],
};

export async function translateUnits(
  units: TranslationUnit[],
  targetLanguageCode: string,
  apiKey: string,
  log?: UsageLogger
): Promise<TranslationResult> {
  if (units.length === 0) {
    return { sourceLanguageCode: targetLanguageCode, translations: [] };
  }
  const stableUnits = [...units]
    .map((unit) => ({ id: unit.id, text: unit.text }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const { content } = await chatCompletion(apiKey, {
    usage: log ? { log, operation: "translate" } : undefined,
    systemPrompt:
      "You are a lossless translation engine. Preserve names, numbers, dates, identifiers, citations, formatting, and meaning. Translate natural-language content into the requested target language. Leave passages already in the target language unchanged. Return exactly one translation for every input id and never alter ids.",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          target_language_code: targetLanguageCode,
          units: stableUnits,
        }),
      },
    ],
    responseSchema: { name: "translation_batch", schema: TRANSLATION_SCHEMA },
    maxTokens: 16_384,
  });
  const parsed = JSON.parse(content) as {
    detected_source_language_code?: string;
    translations?: TranslationUnit[];
  };
  const byId = new Map(
    (parsed.translations ?? []).map((translation) => [translation.id, translation])
  );
  const translations = stableUnits.map((unit) => {
    const translation = byId.get(unit.id);
    if (!translation || typeof translation.text !== "string") {
      throw new Error(`Interfaze omitted translation unit ${unit.id}`);
    }
    return { id: unit.id, text: translation.text };
  });
  return {
    sourceLanguageCode:
      parsed.detected_source_language_code?.trim().toLowerCase() || "und",
    translations,
  };
}


/**
 * OCR a document with the dedicated `ocr` task.
 *
 * Measured against the full model completion on the same PDF, repeatedly:
 *
 *   task: "ocr"   12/12 pages, 0 blank, 96.5% word agreement with the
 *                 document's own embedded text layer — every run, and
 *                 identical across base64, file-URL, and URL-in-text.
 *   full model    non-deterministic. One run returned the same whole-document
 *                 OCR twice (10 blank pages, 6.8%); another returned 7 entries
 *                 for a 12-page file (5 blank, 16.7%); production collapsed all
 *                 12 pages onto page 1.
 *
 * The full model's *structured output* is fine — it is specifically the OCR
 * precontext that is unreliable there — so analysis stays a completion and only
 * page text moves here. It is also ~100x cheaper and ~3x faster.
 */
export async function ocrDocument(
  fileUrl: string,
  filename: string,
  apiKey: string,
  options?: { log?: UsageLogger; bypassCache?: boolean; sizeBytes?: number }
): Promise<{ pages: OcrPageResult[]; precontext: Precontext[]; vcache: boolean }> {
  const result = await chatCompletion(apiKey, {
    task: "ocr",
    content: [
      { type: "text", text: "Extract all text and data." },
      fileUrlContent(fileUrl, filename, options?.sizeBytes),
    ],
    bypassCache: options?.bypassCache,
    usage: options?.log ? { log: options.log, operation: "ocr" } : undefined,
  });

  // Interfaze can bill a full OCR and return an empty string for it.
  //
  // Observed on a 17-page scanned order: `finish_reason: "stop"`, no refusal,
  // no precontext, `content: ""` — and 8,790 completion tokens charged. It
  // reproduces at every page count down to one page, survives cache bypass, and
  // survives re-encoding the PDF, while the identical pages sent as images OCR
  // perfectly. That is the provider dropping output it generated, and it must
  // not be reported to the user as "this document has no text".
  if (!result.content.trim() && result.completionTokens > 0) {
    throw new InterfazeFailure(
      `Interfaze billed ${result.completionTokens} tokens of OCR for this document and returned nothing. ` +
        `This is a provider-side failure, not an empty document — the same pages read correctly as images.`,
      { code: "empty_ocr_response" }
    );
  }

  // A task returns its payload on message.content as `{ result }` rather than
  // as precontext, so normalize it into the precontext shape everything
  // downstream already understands.
  let precontext: Precontext[] = [];
  try {
    const parsed = JSON.parse(result.content) as { result?: unknown };
    const payload =
      parsed && typeof parsed === "object" && "result" in parsed
        ? parsed.result
        : parsed;
    if (payload && typeof payload === "object") {
      precontext = [{ name: "ocr", result: payload }];
    }
  } catch {
    // Leave precontext empty; the caller reports the failure in its own terms.
  }

  return {
    pages: ocrPrecontextToPages(precontext),
    precontext,
    vcache: result.vcache,
  };
}

/**
 * Analyze a document from its OCR text — no file, no vision.
 *
 * Text-in keeps this cheap and, because the input is a deterministic string,
 * an unchanged re-run is eligible for Interfaze's semantic cache. That is what
 * makes Analyze re-runnable without re-reading the document.
 */
export async function analyzeDocumentText(
  pageTexts: string[],
  apiKey: string,
  options: {
    systemPrompt: string;
    prompt: string;
    responseSchema: { name: string; schema: Record<string, unknown> };
    log?: UsageLogger;
    bypassCache?: boolean;
  }
): Promise<ChatResult> {
  const document = pageTexts
    .map((text, index) => `--- Page ${index + 1} ---\n${text}`)
    .join("\n\n");
  return chatCompletion(apiKey, {
    systemPrompt: options.systemPrompt,
    content: [
      inlineTextContent(document),
      { type: "text", text: options.prompt },
    ],
    responseSchema: options.responseSchema,
    maxTokens: 8_192,
    bypassCache: options.bypassCache,
    usage: options.log ? { log: options.log, operation: "analyze" } : undefined,
  });
}

/**
 * REMOVED — `understandDocument`, one full-model completion over the original
 * file that returned OCR precontext and structured analysis together.
 *
 * It was replaced by the `ocr` run-task plus a text-in Analyze, for two
 * independent reasons, and is recorded here so it does not get reinvented as
 * an obvious simplification:
 *
 *  - Correctness. The full model's OCR precontext was non-deterministic on the
 *    same file — repeat runs returned duplicate entries, a wrong entry count,
 *    and in production every page collapsed onto page 1. The task returns one
 *    clean result per document, every time. See docs/scan-precontext-plan.md.
 *  - Cost. It averaged $0.18 a call against $0.012 for the task plus $0.025
 *    for Analyze, and it was 16% of the entire first ledger.
 *
 * Interfaze's own guidance is to batch capabilities into one completion; on
 * this workload that advice is both more expensive and wrong, and the
 * `document_understanding` rows in `apiLogs` are the evidence.
 */


// ---------------------------------------------------------------------------
// Transcribe — audio/video → diarized segments with word-level timestamps.
//
// Interfaze's speech-to-text precontext gives speaker + segment timestamps but
// no per-word timing; the transcript UI needs word-level timing for
// click-to-seek, so this asks for it via a structured-output schema and
// prefers the STT precontext only when it carries word timings.
// ---------------------------------------------------------------------------

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

export interface TranscriptResult {
  sourceLanguageCode: string;
  sourceLanguageIsMixed: boolean;
  segments: TranscriptSegment[];
}

const TRANSCRIPT_SCHEMA = {
  type: "object",
  properties: {
    source_language_code: {
      type: "string",
      description: "Primary spoken language as a lowercase ISO 639 code",
    },
    is_multilingual: {
      type: "boolean",
      description: "True when meaningful speech uses more than one language",
    },
    segments: {
      type: "array",
      description:
        "The full transcript split into speaker turns, in chronological order. Start a new segment whenever the speaker changes.",
      items: {
        type: "object",
        properties: {
          speaker: {
            type: "string",
            description:
              'Diarized speaker label, consistent across the transcript. Use the person\'s name if identifiable from the audio, otherwise "Speaker 1", "Speaker 2", ...',
          },
          start: {
            type: "number",
            description: "Segment start time in seconds from the beginning",
          },
          end: { type: "number", description: "Segment end time in seconds" },
          text: {
            type: "string",
            description: "Verbatim text of this speaker turn",
          },
          words: {
            type: "array",
            description:
              "Every word of the segment with its start/end time in seconds. Word timings must be monotonically increasing and fall within the segment.",
            items: {
              type: "object",
              properties: {
                word: { type: "string" },
                start: { type: "number" },
                end: { type: "number" },
              },
              required: ["word", "start", "end"],
            },
          },
        },
        required: ["speaker", "start", "end", "text", "words"],
      },
    },
  },
  required: ["source_language_code", "is_multilingual", "segments"],
};

/** STT precontext shapes (best-effort — mirrors common word-timing formats) */
interface SttWord {
  word?: string;
  text?: string;
  start?: number;
  end?: number;
  speaker?: string | number;
}
interface SttSegment {
  speaker?: string | number;
  start?: number;
  end?: number;
  text?: string;
  words?: SttWord[];
}
interface SttResult {
  segments?: SttSegment[];
  words?: SttWord[];
}

/**
 * Normalize an STT speaker label to "Speaker N".
 *
 * STT backends emit 0-based labels ("speaker_0", "SPEAKER_00"), so every numeric
 * label is shifted by one — uniformly. Shifting only index 0 would collapse
 * speaker_0 and speaker_1 onto "Speaker 1", silently merging two people.
 */
function normalizeSpeaker(s: string | number | undefined, i: number): string {
  if (typeof s === "number") return `Speaker ${s + 1}`;
  if (typeof s === "string" && s.trim()) {
    const m = s.match(/^speaker[_\s-]?(\d+)$/i);
    return m ? `Speaker ${Number(m[1]) + 1}` : s;
  }
  return `Speaker ${i + 1}`;
}

/**
 * Prefer word timings from an STT precontext entry when one carries per-word
 * timing (ground truth); otherwise fall back to the model's structured output.
 */
function sttToSegments(precontext: Precontext[]): TranscriptSegment[] {
  const stt = precontext.find(
    (p) =>
      typeof p.name === "string" &&
      /stt|asr|transcri|speech|audio/i.test(p.name) &&
      typeof p.result === "object" &&
      p.result !== null
  )?.result as SttResult | undefined;
  if (!stt?.segments?.length) return [];

  const segments = stt.segments
    .map((seg, i) => {
      const words = (seg.words ?? [])
        .map((w) => ({
          word: (w.word ?? w.text ?? "").trim(),
          start: w.start ?? 0,
          end: w.end ?? w.start ?? 0,
        }))
        .filter((w) => w.word);
      const text = seg.text?.trim() || words.map((w) => w.word).join(" ");
      if (!text) return null;
      return {
        speaker: normalizeSpeaker(seg.speaker, i),
        start: seg.start ?? words[0]?.start ?? 0,
        end: seg.end ?? words[words.length - 1]?.end ?? 0,
        text,
        words,
      };
    })
    .filter((s): s is TranscriptSegment => s !== null);

  // Only use the precontext path when it actually carries word-level timing —
  // otherwise defer to the structured-output segments, which do.
  return segments.some((s) => s.words.length > 0) ? segments : [];
}

export async function transcribe(
  fileUrl: string,
  apiKey: string,
  log?: UsageLogger
): Promise<TranscriptResult> {
  const { content, precontext } = await chatCompletion(apiKey, {
    usage: log ? { log, operation: "transcribe" } : undefined,
    content: [
      {
        type: "text",
        // A URL in prompt text has Interfaze's 80 MB limit. A URL wrapped in a
        // file object has the much smaller 20 MB limit even though no bytes
        // are inlined by this app.
        text: `Transcribe the recording at this URL verbatim with speaker diarization and word-level timestamps according to the response schema: ${fileUrl}`,
      },
    ],
    responseSchema: { name: "transcript", schema: TRANSCRIPT_SCHEMA },
  });

  const parsed = JSON.parse(content) as {
    source_language_code?: string;
    is_multilingual?: boolean;
    segments?: TranscriptSegment[];
  };
  const fromStt = sttToSegments(precontext);
  const segments = (fromStt.length > 0 ? fromStt : parsed.segments ?? [])
    .map((seg) => ({
      speaker: seg.speaker?.trim() || "Speaker 1",
      start: seg.start ?? 0,
      end: seg.end ?? 0,
      text: seg.text ?? "",
      words: (seg.words ?? []).filter((w) => w.word?.trim()),
    }))
    .filter((s) => s.text.trim());
  return {
    sourceLanguageCode:
      parsed.source_language_code?.trim().toLowerCase().replaceAll("_", "-") ||
      "und",
    sourceLanguageIsMixed: parsed.is_multilingual === true,
    segments,
  };
}

// ---------------------------------------------------------------------------
// Extract — structured data extraction via JSON schema.
// ---------------------------------------------------------------------------

export async function extract(
  source: string | { inlineText: string },
  apiKey: string,
  pageSchema: Record<string, unknown>,
  options?: { pageRange?: string; log?: UsageLogger }
): Promise<ExtractResult> {
  const rangeClause = options?.pageRange
    ? ` Only consider pages ${options.pageRange} of the document.`
    : "";

  const { content } = await chatCompletion(apiKey, {
    usage: options?.log
      ? { log: options.log, operation: "extract" }
      : undefined,
    content: [
      typeof source === "string"
        ? fileUrlContent(source)
        : inlineTextContent(source.inlineText),
      {
        type: "text",
        text: `Extract structured data from this document according to the response schema. Only include values actually present in the document.${rangeClause}`,
      },
    ],
    responseSchema: { name: "extraction", schema: pageSchema },
  });

  return { extraction_schema_json: content || "{}" };
}

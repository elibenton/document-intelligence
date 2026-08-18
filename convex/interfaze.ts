/**
 * Interfaze client for Convex actions — a plain-`fetch` implementation of the
 * OpenAI-compatible Chat Completions call Interfaze serves
 * (https://interfaze.ai/docs). A single completion returns both the model's
 * answer and a `precontext` array carrying the raw specialist metadata (for
 * documents: OCR sections → lines → words with bounding boxes and confidence).
 *
 * This used to wrap the official `interfaze` SDK; the SDK was the only reason
 * every Interfaze-calling action carried "use node". The wire behaviors the
 * SDK contributed are reproduced here exactly, because the request body is a
 * vcache input and a byte-level drift is a silent cache-miss regression:
 *   - body key order: max_tokens?, reasoning_effort?, model, messages,
 *     response_format? (the SDK's `prepare` spread order);
 *   - `task` is not a body field — it becomes a `<task>…</task>` tag prepended
 *     as/into the system message, plus an empty json_schema response_format;
 *   - `bypassCache` is the `x-interfaze-bypass-cache: true` header;
 *   - a file part is `{ type: "file", file: { file_data, filename?, format? } }`
 *     with `format` derived from the filename extension.
 *
 * New document uploads run the dedicated `ocr` task rather than a full-model
 * completion: it is deterministic where the full model was not, and about a
 * tenth of the cost. Its OCR precontext becomes the app's stored page text,
 * line/word blocks, boxes, and confidence; the structured understanding is a
 * second, text-in call (`analyzeDocumentText`) over that stored text.
 *
 * This module keeps a small set of app-facing helpers (`chatCompletion`,
 * `understandDocument`, `ocrDocument`, `analyzeDocumentText`, and
 * `transcribe`) so the cross-cutting concerns the app owns — usage/cost
 * logging and mapping HTTP failures onto the UI's FailureCodes — live in one
 * place.
 */

import { fnv1a } from "./hash";
import { InterfazeFailure } from "./interfazeErrors";
import { interfazeCostUsd } from "./interfazeCost";
import type { UsageLogger } from "./interfazeCost";
import { ocrPrecontextToPages } from "./interfazeOcr";
import { checkGeometry } from "./ocrChecks";
import type { OcrPageResult, Precontext } from "./interfazeOcr";
import { chunksToSegments } from "./interfazeStt";
import type { SttTaskResult, TranscriptResult } from "./interfazeStt";

// Re-exported so every existing `from "./interfaze"` import keeps working —
// callers should not have to know which of these modules a symbol lives in.
export * from "./interfazeCost";
export * from "./interfazeErrors";
export * from "./interfazeOcr";
export * from "./interfazeStt";

const INTERFAZE_BASE_URL = "https://api.interfaze.ai/v1";
const INTERFAZE_MODEL = "interfaze-beta";

// Convex kills actions at 10 minutes without running catch blocks, which would
// strand documents in "parsing"/"extracting". Time the request out first so
// the action's own error handling can mark the job failed. Interfaze documents
// a 5-minute maximum per request (https://interfaze.ai/docs/limits), so
// anything still open past that is dead air — 5:30 gives the provider its
// full budget plus network slack while leaving the action minutes to clean up.
const INTERFAZE_TIMEOUT_MS = 5.5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Wire types — the subset of the Chat Completions shape this app sends and
// reads. Owned here since the `interfaze` SDK dependency was removed.
// ---------------------------------------------------------------------------

export type ChatCompletionContentPart =
  | { type: "text"; text: string }
  | {
      type: "file";
      file: { file_data: string; filename?: string; format?: string };
    };

export type ChatCompletionMessageParam = {
  role: "system" | "user";
  content: string | ChatCompletionContentPart[];
};

/** The built-in Interfaze tasks this app runs. */
export type TaskName = "ocr" | "speech_to_text";

interface WireError {
  error?: { code?: string; message?: string };
}

interface WireCompletion {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  precontext?: Precontext[];
  vcache?: boolean;
}

/**
 * Mime type from a filename extension — the SDK's table, kept verbatim so the
 * `format` field on file parts (a vcache input) is byte-identical to what the
 * SDK sent for the same filename. Unknown extensions omit the field, as the
 * SDK did.
 */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xml: "application/xml",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  yaml: "application/yaml",
  yml: "application/yaml",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  "3gp": "video/3gpp",
};

function mimeFromFilename(name: string): string | undefined {
  const ext = name.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase();
  return ext ? EXT_MIME[ext] : undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


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
 * Classify a non-OK HTTP response into an InterfazeFailure. An exhausted
 * balance surfaces as a 403 whose error code/message names quota or credits,
 * so check that before the generic status cases (which would misread it as a
 * key problem).
 */
function classifyHttpError(status: number, body: WireError): InterfazeFailure {
  const providerCode =
    typeof body.error?.code === "string" ? body.error.code.toLowerCase() : "";
  const message = body.error?.message ?? "";
  const haystack = `${providerCode} ${message}`.toLowerCase();

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
  if (status === 401 || status === 403) {
    return new InterfazeFailure(
      "Interfaze rejected the API key — check INTERFAZE_API_KEY in the Convex deployment.",
      { code: "invalid_api_key", status }
    );
  }
  if (status === 429) {
    return new InterfazeFailure(
      "Interfaze rate limit hit — processing will retry shortly.",
      { code: "rate_limited", status }
    );
  }
  // The provider sometimes echoes the request back in its error prose, and the
  // request contains the document's storage URL — which Convex never expires,
  // so a copy in `apiLogs.error` or `issues.samples[].raw` would be a working
  // document link sitting in a table row. Strip it before the message is
  // stored anywhere.
  const detail = message
    .replace(/https?:\/\/\S*\/api\/storage\/\S+/g, "[storage-url]")
    .slice(0, 300);
  return new InterfazeFailure(
    `Interfaze API error (${status})${detail ? `: ${detail}` : ""}`,
    { status }
  );
}

function timeoutFailure(): InterfazeFailure {
  return new InterfazeFailure(
    `Interfaze request timed out after ${Math.round(
      INTERFAZE_TIMEOUT_MS / 60000
    )} minutes — the document may be too large to process in one pass`,
    { code: "timeout" }
  );
}

// Statuses worth an automatic retry — the provider answered with a transient
// failure, so no completion was produced or billed. Timeouts and *network*
// errors are deliberately not retried: Interfaze may have completed (and
// billed) a request before the failure was observed, so a retry could
// duplicate a billable call — the same invariant upload.ts states for its
// path. A retried 5-minute timeout would also blow the Convex action limit.
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

/**
 * POST one Chat Completions request. Throws InterfazeFailure on anything that
 * is not a 2xx with a JSON body; retries transient statuses and network
 * errors with a short backoff.
 */
async function postChatCompletion(
  apiKey: string,
  body: Record<string, unknown>,
  bypassCache?: boolean
): Promise<WireCompletion> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    // Zero data retention: users' documents stay out of provider training.
    // Verified 2026-08-18 to change neither usage reporting nor cache hits —
    // an exact repeat under this header still returned vcache: true.
    "x-interfaze-zdr": "true",
  };
  if (bypassCache) headers["x-interfaze-bypass-cache"] = "true";
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INTERFAZE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${INTERFAZE_BASE_URL}/chat/completions`, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw timeoutFailure();
      throw new InterfazeFailure(
        `Interfaze request failed: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      return (await res.json()) as WireCompletion;
    }
    if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    const errBody = (await res.json().catch(() => ({}))) as WireError;
    throw classifyHttpError(res.status, errBody);
  }
}

// ---------------------------------------------------------------------------
// Content-part helpers.
// ---------------------------------------------------------------------------

/**
 * Reference a document by URL as a `file` content part. Interfaze fetches it at
 * inference time; a stable URL (same bytes → same URL) is also the cache key,
 * so repeat calls against the same file hit the cache.
 *
 * Always a file part, never a bare URL in prompt text. Two independent
 * measurements both point the same way: the visual-evidence A/B (text URLs
 * confabulated logos/seals; file parts were clean), and the 2026-08-18 probes,
 * where the full model given a URL in prompt text silently analyzed the wrong
 * document three times out of three while the file part read the right one
 * every time. The old URL-in-text fallback for oversized files traded that
 * correctness risk for acceptance; the upload gate now rejects what the file
 * part cannot carry (PROVIDER_FILE_PART_SAFE_BYTES), so the fallback is gone.
 *
 * The size gate lives at upload, once (PROVIDER_FILE_PART_SAFE_BYTES in
 * interfazeLimits.ts), not per call.
 */
export function fileUrlContent(
  url: string,
  filename = "document.pdf"
): ChatCompletionContentPart {
  const format = mimeFromFilename(filename);
  return {
    type: "file",
    file: { file_data: url, filename, ...(format ? { format } : {}) },
  };
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
    /** When set, token usage + cost for this call is reported to the log. */
    usage?: {
      log: UsageLogger;
      operation: string;
      /**
       * Zero-ground-truth quality check, run at report time on a successful
       * response so its numbers land on the same apiLogs row as the call's
       * cost. Must be pure and cheap; a throw here is swallowed — quality
       * measurement must never break the call it describes.
       */
      quality?: (result: {
        content: string;
        precontext: Precontext[];
      }) => { checked: number; violations: number; byKind: Record<string, number> } | undefined;
    };
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
    outputShapeValid?: boolean;
    quality?: { checked: number; violations: number; byKind: Record<string, number> };
  }) => {
    if (!options.usage) return;
    const promptTokens = report.promptTokens ?? 0;
    const completionTokens = report.completionTokens ?? 0;
    await options.usage.log({
      outputShapeValid: report.outputShapeValid,
      qualityChecked: report.quality?.checked,
      qualityViolations: report.quality?.violations,
      qualityByKind: report.quality?.byKind,
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

  if (options.task && options.responseSchema) {
    throw new InterfazeFailure(
      "A response schema cannot be combined with a task — Interfaze runs tasks with raw output."
    );
  }

  // A task is not a body field: it rides as a `<task>` tag in the system
  // message and forces an empty json_schema response_format (the SDK's
  // `injectTags` + `emptyTaskSchema` behavior, reproduced byte-for-byte).
  const taskTag = options.task ? `<task>${options.task}</task>` : undefined;
  const messages: ChatCompletionMessageParam[] = [];
  if (options.systemPrompt) {
    messages.push({
      role: "system",
      content: taskTag
        ? `${taskTag}\n${options.systemPrompt}`
        : options.systemPrompt,
    });
  } else if (taskTag) {
    messages.push({ role: "system", content: taskTag });
  }
  messages.push({ role: "user", content: options.content });

  // Key order matters: the serialized body is a vcache input, so this follows
  // the SDK's order exactly — max_tokens?, model, messages, response_format?.
  // Reasoning was removed everywhere (2026-08-18): it multiplied cost on every
  // call that carried it and never measurably earned it.
  const body: Record<string, unknown> = {
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    model: INTERFAZE_MODEL,
    messages,
  };
  if (options.task) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "empty_schema", schema: {} },
    };
  } else if (options.responseSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: options.responseSchema.name,
        schema: options.responseSchema.schema,
      },
    };
  }

  try {
    const res = await postChatCompletion(apiKey, body, options.bypassCache);

    const content = res.choices?.[0]?.message?.content ?? "";
    let quality;
    if (options.usage?.quality) {
      try {
        quality = options.usage.quality({
          content,
          precontext: res.precontext ?? [],
        });
      } catch (e) {
        console.error("Quality check threw; logging the call without it:", e);
      }
    }
    // A structured call whose content does not parse is a billed response the
    // caller cannot use; recorded per call so the rate is queryable.
    let outputShapeValid: boolean | undefined;
    if (options.responseSchema || options.task) {
      try {
        JSON.parse(content);
        outputShapeValid = true;
      } catch {
        outputShapeValid = false;
      }
    }
    await reportUsage({
      status: "ok",
      quality,
      outputShapeValid,
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
      cacheHit: res.vcache ?? false,
      // "length" means the provider stopped early. We pay for the emitted
      // tokens either way and get unparseable JSON back, so this is the one
      // quality signal that is free, self-evident, and currently unmeasured.
      finishReason: res.choices?.[0]?.finish_reason ?? undefined,
      outputHash: fnv1a(content.trim()),
    });
    return {
      content,
      precontext: res.precontext ?? [],
      vcache: res.vcache ?? false,
      completionTokens: res.usage?.completion_tokens ?? 0,
    };
  } catch (e) {
    const failure =
      e instanceof InterfazeFailure
        ? e
        : new InterfazeFailure(e instanceof Error ? e.message : String(e));
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
/**
 * A task returns its payload on message.content as `{ result }` rather than
 * as precontext, so normalize it into the precontext shape everything
 * downstream already understands. Unparseable content yields an empty array;
 * the caller reports that failure in its own terms.
 */
function ocrContentToPrecontext(content: string): Precontext[] {
  try {
    const parsed = JSON.parse(content) as { result?: unknown };
    const payload =
      parsed && typeof parsed === "object" && "result" in parsed
        ? parsed.result
        : parsed;
    if (payload && typeof payload === "object") {
      return [{ name: "ocr", result: payload }];
    }
  } catch {
    // fall through
  }
  return [];
}

export async function ocrDocument(
  fileUrl: string,
  filename: string,
  apiKey: string,
  options?: { log?: UsageLogger; bypassCache?: boolean }
): Promise<{ pages: OcrPageResult[]; precontext: Precontext[]; vcache: boolean }> {
  const result = await chatCompletion(apiKey, {
    task: "ocr",
    content: [
      { type: "text", text: "Extract all text and data." },
      fileUrlContent(fileUrl, filename),
    ],
    bypassCache: options?.bypassCache,
    usage: options?.log
      ? {
          log: options.log,
          operation: "ocr",
          // Geometry is wrong by arithmetic or it is not wrong at all, so the
          // check runs on every scan and its numbers land on this call's own
          // apiLogs row. Re-parses the content the main path parses again
          // below — pure string work, microseconds against a multi-second
          // API call, and it keeps the quality hook side-effect-free.
          quality: ({ content }) => {
            const pages = ocrPrecontextToPages(ocrContentToPrecontext(content));
            const { checked, violations, byKind } = checkGeometry(pages);
            return { checked, violations, byKind };
          },
        }
      : undefined,
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

  const precontext = ocrContentToPrecontext(result.content);

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
 * REINSTATED (2026-08-18) — one full-model completion over the original file:
 * structured analysis (with the entity graph riding along) on `content`, and
 * the specialist output (OCR geometry / transcript) expected on `precontext`.
 *
 * An earlier version was removed with two measured objections, overturned
 * deliberately rather than forgotten:
 *
 *  - Correctness: the full model's OCR precontext was non-deterministic
 *    (duplicate entries, wrong entry count, pages collapsed onto page 1).
 *    Today it is worse — probes on 2026-08-18 show `precontext` comes back
 *    empty on every full-model call, contradicting the provider's docs. That
 *    is reported to Interfaze as a bug; until it is fixed, callers shim the
 *    geometry from the dedicated task (see processingStages.runPipeline), so
 *    the old non-determinism cannot bite either way.
 *  - Cost: ~$0.18 a call against ~$0.037 for task + text-Analyze. Accepted:
 *    the merged call replaces Analyze + relationships + rename in one request,
 *    and the decision (2026-08-18) is to buy the simpler architecture and
 *    watch the measured cost in apiLogs rather than assume it.
 */
export async function understandDocument(
  fileUrl: string,
  filename: string,
  apiKey: string,
  options: {
    systemPrompt: string;
    prompt: string;
    responseSchema: { name: string; schema: Record<string, unknown> };
    log?: UsageLogger;
    bypassCache?: boolean;
  }
): Promise<ChatResult> {
  return chatCompletion(apiKey, {
    systemPrompt: options.systemPrompt,
    content: [
      { type: "text", text: options.prompt },
      fileUrlContent(fileUrl, filename),
    ],
    responseSchema: options.responseSchema,
    bypassCache: options.bypassCache,
    usage: options.log ? { log: options.log, operation: "understand" } : undefined,
  });
}


// ---------------------------------------------------------------------------
// Transcribe — audio/video → diarized segments with word-level timestamps,
// via the dedicated `speech_to_text` task.
//
// This was a full-model completion driving a structured-output schema that
// required `{word, start, end}` for every word. Measured against the task on
// the same file, that was the wrong shape twice over:
//
//   task            returns `{text, chunks}` where every chunk is one word with
//                   `timestamp: [start, end]` *and* a `speaker` — strictly more
//                   than the schema asked for, as ground truth rather than as
//                   something the model re-derives.
//   full model      re-emits all of it as JSON at roughly 22 output tokens per
//                   spoken word. The SDK caps output at 32,000 tokens
//                   (`LIMITS.maxOutputTokens`), so a recording longer than
//                   about ten minutes of speech did not transcribe slowly — it
//                   was cut at `finish_reason: "length"` and died in JSON.parse
//                   as "Unexpected end of JSON input".
//
// So the ceiling that mattered was never the file size, and no amount of
// chunking or parallelism would have addressed it: the fix is to stop paying to
// re-emit data the provider already returned. This is the same move `ocr` made
// (see ocrDocument) for the same reason.
//
// Language detection left with the schema. Analyze already carries
// `source_language_code` and `is_multilingual` (analyzePrompt.ts) and now runs
// on recordings, so it is the one writer of those fields for every medium.
// ---------------------------------------------------------------------------

export async function transcribe(
  fileUrl: string,
  apiKey: string,
  log?: UsageLogger
): Promise<TranscriptResult> {
  const { content, completionTokens } = await chatCompletion(apiKey, {
    task: "speech_to_text",
    usage: log ? { log, operation: "transcribe" } : undefined,
    content: [
      {
        type: "text",
        // URL in prompt text, unlike everything else. Tasks read a text URL
        // reliably (measured "identical across base64, file-URL, and
        // URL-in-text" for ocr; the wrong-document misfetch of 2026-08-18 was
        // the full model, not a task), and the upload gate already holds every
        // recording under the shared file-part ceiling either way.
        text: `Transcribe the recording at this URL verbatim with speaker diarization and word-level timestamps: ${fileUrl}`,
      },
    ],
  });

  // A task returns its payload on message.content as `{ name, result }`. Parsed
  // defensively: the previous implementation let a bare SyntaxError out of
  // JSON.parse, which reached the user as "Transcription failed: Unexpected end
  // of JSON input" and named neither the cause nor anything actionable.
  let payload: SttTaskResult;
  try {
    const parsed = JSON.parse(content) as { result?: SttTaskResult };
    payload = parsed?.result ?? {};
  } catch {
    throw new InterfazeFailure(
      `Interfaze returned a speech-to-text response this app could not read ` +
        `(${completionTokens} tokens billed, ${content.length} characters). ` +
        `The recording was not transcribed.`,
      { code: "malformed_transcript" }
    );
  }

  const segments = chunksToSegments(payload.chunks ?? []);
  if (segments.length > 0) return { segments };

  // Every known failure returns no chunks, so the fallbacks are ordered by how
  // much they can still offer: whole-transcript text with no timings is worth
  // keeping (it still searches, embeds, analyzes and extracts — only
  // click-to-seek is lost), and nothing at all is an error rather than an
  // empty transcript, the way ocrDocument treats a billed empty response.
  const whole = (payload.text ?? "").trim();
  if (whole) {
    return {
      segments: [
        { speaker: "Speaker 1", start: 0, end: 0, text: whole, words: [] },
      ],
    };
  }
  if (completionTokens > 0) {
    throw new InterfazeFailure(
      `Interfaze billed ${completionTokens} tokens of transcription for this ` +
        `recording and returned no speech. This is a provider-side failure, ` +
        `not a silent recording.`,
      { code: "empty_transcript" }
    );
  }
  return { segments: [] };
}


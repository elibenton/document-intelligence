"use node";

/**
 * Interfaze client for Convex actions — built on the official `interfaze` SDK
 * (https://interfaze.ai/docs), a typed wrapper over the OpenAI Chat Completions
 * shape. A single completion returns both the model's answer and a `precontext`
 * array carrying the raw specialist metadata (for documents: OCR sections →
 * lines → words with bounding boxes and confidence).
 *
 * New document uploads use one normal whole-file completion: Interfaze runs
 * OCR and object detection before producing the structured document analysis.
 * Raw OCR precontext becomes the app's stored page text, line/word blocks,
 * boxes, and confidence; detected graphics come from the structured response.
 *
 * This module keeps a small set of app-facing helpers (`chatCompletion`,
 * `understandDocument`, `extract`, and `transcribe`) so the
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
} from "interfaze";

const INTERFAZE_MODEL = "interfaze-beta";

// Convex kills actions at 10 minutes without running catch blocks, which would
// strand documents in "parsing"/"extracting". Time the request out first so
// the action's own error handling can mark the job failed. (Interfaze itself
// caps a request at 5 minutes; this is the outer Convex-facing guard.)
const INTERFAZE_TIMEOUT_MS = 9 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InterfazeWord {
  text: string;
  bbox?: Bbox;
  confidence?: number;
}

/** Flattened block for storage (same shape the ingest mutations expect). */
export interface InterfazeBlock {
  id: string;
  block_type: string;
  text: string;
  page: number;
  bbox?: Bbox;
  confidence?: number;
  words?: InterfazeWord[];
}

export interface InterfazePageDimension {
  page: number;
  width: number;
  height: number;
}

export interface ExtractResult {
  extraction_schema_json: string; // JSON string of extracted data
}

export interface ChatResult {
  content: string;
  precontext: Precontext[];
  /** True when Interfaze served this completion from its vcache. */
  vcache: boolean;
}

export interface DocumentUnderstandingResult extends ChatResult {
  pages: OcrPageResult[];
  pageSource: "precontext" | "structured" | "none";
}

export interface TranslationUnit {
  id: string;
  text: string;
}

export interface TranslationResult {
  sourceLanguageCode: string;
  translations: TranslationUnit[];
}

// ---------------------------------------------------------------------------
// Usage logging — every call reports its token usage + estimated cost to an
// optional logger (see convex/apiLogs.ts), which persists the mini API log
// shown on the settings page.
// ---------------------------------------------------------------------------

export interface ApiUsage {
  provider: string;
  operation: string;
  model: string;
  status: "ok" | "error";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  cacheHit?: boolean;
  error?: string;
}

export type UsageLogger = (usage: ApiUsage) => Promise<void>;

// Interfaze pricing (https://interfaze.ai/pricing). Cached tokens are free and
// excluded from the reported token counts, so no cache adjustment is needed.
const INTERFAZE_USD_PER_M_INPUT = 1.5;
const INTERFAZE_USD_PER_M_OUTPUT = 3.5;

export function interfazeCostUsd(
  promptTokens: number,
  completionTokens: number
): number {
  return (
    (promptTokens * INTERFAZE_USD_PER_M_INPUT +
      completionTokens * INTERFAZE_USD_PER_M_OUTPUT) /
    1e6
  );
}

// ---------------------------------------------------------------------------
// Failure classification
//
// Provider failures are not interchangeable: running out of credits is an
// account-level condition that blocks every document until a human tops up,
// while a timeout is per-document and worth retrying. The SDK throws typed
// error classes; map them onto a small code the UI renders a specific state
// for.
// ---------------------------------------------------------------------------

export type FailureCode =
  | "insufficient_credits"
  | "invalid_api_key"
  | "rate_limited"
  | "timeout";

/** Codes that no retry can clear — a human has to act before work resumes. */
const TERMINAL_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  "insufficient_credits",
  "invalid_api_key",
]);

/** A classified failure: our code + a message written in the user's terms. */
export class InterfazeFailure extends Error {
  readonly code?: FailureCode;
  readonly status?: number;

  constructor(
    message: string,
    options?: { code?: FailureCode; status?: number }
  ) {
    super(message);
    this.name = "InterfazeFailure";
    this.code = options?.code;
    this.status = options?.status;
  }

  /** True when retrying is pointless until someone changes the account state. */
  get isTerminal(): boolean {
    return this.code !== undefined && TERMINAL_CODES.has(this.code);
  }
}

/** Read the failure code off an unknown caught value. */
export function failureCodeOf(e: unknown): FailureCode | undefined {
  return e instanceof InterfazeFailure ? e.code : undefined;
}

export function isTerminalFailure(e: unknown): boolean {
  return e instanceof InterfazeFailure && e.isTerminal;
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
 * and was clean with file objects.
 */
export function fileUrlContent(
  url: string,
  filename = "document.pdf"
): ChatCompletionContentPart {
  return inputs.file(url, { filename });
}

/**
 * Inline a text document's content directly in the prompt. Used for web clips:
 * Interfaze's file specialists fetch PDFs/images by URL, but a bare URL to a
 * text file is not reliably fetched — inlining the (small) text is
 * deterministic. Capped to stay within prompt limits.
 */
const MAX_INLINE_TEXT_CHARS = 200_000;

export function inlineTextContent(text: string): ChatCompletionContentPart {
  const clipped =
    text.length > MAX_INLINE_TEXT_CHARS
      ? `${text.slice(0, MAX_INLINE_TEXT_CHARS)}\n\n[truncated]`
      : text;
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
  }
): Promise<ChatResult> {
  const startedAt = Date.now();
  const reportUsage = async (report: {
    status: "ok" | "error";
    promptTokens?: number;
    completionTokens?: number;
    cacheHit?: boolean;
    error?: string;
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
      costUsd: interfazeCostUsd(promptTokens, completionTokens),
      durationMs: Date.now() - startedAt,
      cacheHit: report.cacheHit,
      error: report.error,
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

    await reportUsage({
      status: "ok",
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
      cacheHit: res.vcache,
    });
    return {
      content: res.choices?.[0]?.message?.content ?? "",
      precontext: res.precontext ?? [],
      vcache: res.vcache,
    };
  } catch (e) {
    const failure = classifyError(e);
    await reportUsage({ status: "error", error: failure.message });
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

// ---------------------------------------------------------------------------
// OCR precontext → blocks
//
// Interfaze's OCR result (https://interfaze.ai/docs/vision/ocr) is nested
// sections → lines → words, each line/word carrying `bounds` (four corner
// points + width/height) and a confidence (`average_confidence` on lines,
// `confidence` on words), plus per-image `width`/`height`. We flatten that into
// one line-level block per line (with its words) for the viewer's overlays.
// ---------------------------------------------------------------------------

interface OcrPoint {
  x?: number;
  y?: number;
}
interface OcrBounds {
  top_left?: OcrPoint;
  top_right?: OcrPoint;
  bottom_right?: OcrPoint;
  bottom_left?: OcrPoint;
  width?: number;
  height?: number;
}
interface OcrWord {
  text?: string;
  bounds?: OcrBounds;
  confidence?: number;
}
interface OcrLine {
  text?: string;
  bounds?: OcrBounds;
  average_confidence?: number;
  words?: OcrWord[];
}
interface OcrSection {
  text?: string;
  lines?: OcrLine[];
}
interface OcrResult {
  extracted_text?: string;
  sections?: OcrSection[];
  width?: number;
  height?: number;
  total_pages?: number;
}

function boundsToBbox(
  bounds: OcrBounds | undefined,
  scaleX = 1,
  scaleY = 1
): Bbox | undefined {
  if (!bounds) return undefined;
  const points = [
    bounds.top_left,
    bounds.top_right,
    bounds.bottom_right,
    bounds.bottom_left,
  ].filter(
    (p): p is Required<OcrPoint> =>
      typeof p?.x === "number" && typeof p?.y === "number"
  );
  if (points.length < 3) return undefined;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) * scaleX;
  const y = Math.min(...ys) * scaleY;
  return {
    x,
    y,
    width: (Math.max(...xs) - Math.min(...xs)) * scaleX,
    height: (Math.max(...ys) - Math.min(...ys)) * scaleY,
  };
}

function sectionCoordinateMax(section: OcrSection) {
  let maxX = 0;
  let maxY = 0;
  const include = (bounds: OcrBounds | undefined) => {
    for (const point of [
      bounds?.top_left,
      bounds?.top_right,
      bounds?.bottom_right,
      bounds?.bottom_left,
    ]) {
      if (typeof point?.x === "number") maxX = Math.max(maxX, point.x);
      if (typeof point?.y === "number") maxY = Math.max(maxY, point.y);
    }
  };
  for (const line of section.lines ?? []) {
    include(line.bounds);
    for (const word of line.words ?? []) include(word.bounds);
  }
  return { maxX, maxY };
}

/** OCR may rasterize a rotated axis at an integer multiple of page pixels. */
function coordinateScale(maxCoordinate: number, pageDimension?: number) {
  if (!pageDimension || maxCoordinate <= pageDimension * 1.1) return 1;
  return 1 / Math.max(1, Math.ceil(maxCoordinate / pageDimension - 0.05));
}

function collectOcrResults(precontext: Precontext[]): OcrResult[] {
  return precontext
    .filter(
      (p) =>
        p.name === "ocr" && typeof p.result === "object" && p.result !== null
    )
    .map((p) => p.result as OcrResult);
}

/**
 * Normalize the OCR precontext into per-page groups.
 *
 * Whole PDFs arrive either as one OCR result per page, or as a single result
 * with one section per page. Section bounds are page-local. Rotated source
 * pages may be processed at an integer multiple along one axis, so each page
 * records the scale needed to return to its declared page dimensions.
 */
function ocrToPages(
  ocrs: OcrResult[]
): {
  sections: OcrSection[];
  width?: number;
  height?: number;
  scaleX: number;
  scaleY: number;
}[] {
  if (ocrs.length === 0) return [];
  const total = ocrs.find((o) => typeof o.total_pages === "number")
    ?.total_pages;

  if (ocrs.length > 1) {
    const pageEntries =
      total && ocrs.length > total ? ocrs.slice(0, total) : ocrs;
    return pageEntries.map((o) => {
      const sections = o.sections ?? [];
      const extent = sections.reduce(
        (max, section) => {
          const current = sectionCoordinateMax(section);
          return {
            maxX: Math.max(max.maxX, current.maxX),
            maxY: Math.max(max.maxY, current.maxY),
          };
        },
        { maxX: 0, maxY: 0 }
      );
      return {
        sections,
        width: o.width,
        height: o.height,
        scaleX: coordinateScale(extent.maxX, o.width),
        scaleY: coordinateScale(extent.maxY, o.height),
      };
    });
  }

  const only = ocrs[0];
  const sections = only.sections ?? [];
  if (total && total > 1 && sections.length === total) {
    const pageHeight =
      typeof only.height === "number" ? only.height / total : undefined;
    return sections.map((section) => {
      const extent = sectionCoordinateMax(section);
      return {
        sections: [section],
        width: only.width,
        height: pageHeight,
        scaleX: coordinateScale(extent.maxX, only.width),
        scaleY: coordinateScale(extent.maxY, pageHeight),
      };
    });
  }
  return [
    {
      sections,
      width: only.width,
      height: only.height,
      scaleX: coordinateScale(
        sections.reduce(
          (max, section) => Math.max(max, sectionCoordinateMax(section).maxX),
          0
        ),
        only.width
      ),
      scaleY: coordinateScale(
        sections.reduce(
          (max, section) => Math.max(max, sectionCoordinateMax(section).maxY),
          0
        ),
        only.height
      ),
    },
  ];
}

function ocrToBlocks(ocrs: OcrResult[]): {
  blocks: InterfazeBlock[];
  pageDimensions: InterfazePageDimension[];
  pageTexts: string[];
} {
  const blocks: InterfazeBlock[] = [];
  const pageDimensions: InterfazePageDimension[] = [];
  const pageTexts: string[] = [];

  ocrToPages(ocrs).forEach((page, pageIndex) => {
    pageTexts.push(
      page.sections.map((s) => s.text ?? "").filter(Boolean).join("\n\n")
    );
    if (typeof page.width === "number" && typeof page.height === "number") {
      pageDimensions.push({
        page: pageIndex,
        width: page.width,
        height: page.height,
      });
    }
    let lineIndex = 0;
    for (const section of page.sections) {
      for (const line of section.lines ?? []) {
        const text = (line.text ?? "").trim();
        if (!text) continue;
        const words = (line.words ?? [])
          .filter((w) => (w.text ?? "").trim())
          .map((w) => ({
            text: (w.text ?? "").trim(),
            bbox: boundsToBbox(w.bounds, page.scaleX, page.scaleY),
            confidence: w.confidence,
          }));
        blocks.push({
          id: `p${pageIndex}_l${lineIndex++}`,
          block_type: "Line",
          text,
          page: pageIndex,
          bbox: boundsToBbox(line.bounds, page.scaleX, page.scaleY),
          confidence: line.average_confidence,
          words: words.length > 0 ? words : undefined,
        });
      }
    }
  });

  return { blocks, pageDimensions, pageTexts };
}

/** Normalize every OCR entry from a normal completion into stored pages. */
export function ocrPrecontextToPages(
  precontext: Precontext[]
): OcrPageResult[] {
  const ocrs = collectOcrResults(precontext);
  if (ocrs.length === 0) return [];
  const { blocks, pageDimensions, pageTexts } = ocrToBlocks(ocrs);
  const reportedPageCount = ocrs.reduce(
    (count, ocr) => Math.max(count, ocr.total_pages ?? 0),
    0
  );
  const pageCount = Math.max(
    reportedPageCount,
    pageTexts.length,
    ...blocks.map((block) => block.page + 1),
    1
  );
  return Array.from({ length: pageCount }, (_, pageNumber) => ({
    pageNumber,
    text: (pageTexts[pageNumber] ?? "").trim(),
    width:
      pageDimensions.find((dimension) => dimension.page === pageNumber)?.width,
    height:
      pageDimensions.find((dimension) => dimension.page === pageNumber)?.height,
    blocks: blocks.filter((block) => block.page === pageNumber),
  }));
}

interface StructuredOcrPage {
  page_number?: unknown;
  text?: unknown;
}

/**
 * Fall back to the combined completion's required page text when Interfaze
 * omits OCR precontext. This intentionally creates one coarse block per page:
 * precontext remains the authoritative source for word-level geometry, while
 * structured text preserves reading, search, translation, and extraction.
 */
export function structuredContentToPages(content: string): OcrPageResult[] {
  let parsed: { pages?: unknown };
  try {
    parsed = JSON.parse(content) as { pages?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.pages)) return [];

  const pageText = new Map<number, string>();
  for (const candidate of parsed.pages as StructuredOcrPage[]) {
    const ordinal = candidate.page_number;
    const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
    if (
      typeof ordinal !== "number" ||
      !Number.isInteger(ordinal) ||
      ordinal < 1 ||
      ordinal > 10_000 ||
      !text
    ) {
      continue;
    }
    pageText.set(ordinal - 1, text);
  }
  if (pageText.size === 0) return [];

  const pageCount = Math.max(...pageText.keys()) + 1;
  return Array.from({ length: pageCount }, (_, pageNumber) => {
    const text = pageText.get(pageNumber) ?? "";
    return {
      pageNumber,
      text,
      blocks: text
        ? [
            {
              id: `p${pageNumber}_structured`,
              block_type: "PageText",
              text,
              page: pageNumber,
            },
          ]
        : [],
    };
  });
}

/**
 * Run Interfaze's idiomatic document flow: one normal completion over the
 * original file. OCR and object detection are selected by the prompt/schema,
 * returned as precontext, and used by Interfaze before it emits the structured
 * analysis. This deliberately does not set `task`.
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
): Promise<DocumentUnderstandingResult> {
  const result = await chatCompletion(apiKey, {
    systemPrompt: options.systemPrompt,
    content: [
      fileUrlContent(fileUrl, filename),
      { type: "text", text: options.prompt },
    ],
    responseSchema: options.responseSchema,
    maxTokens: 8_192,
    bypassCache: options.bypassCache,
    usage: options.log
      ? { log: options.log, operation: "document_understanding" }
      : undefined,
  });
  const precontextPages = ocrPrecontextToPages(result.precontext);
  const structuredPages = structuredContentToPages(result.content);
  const pages =
    precontextPages.length > 0 ? precontextPages : structuredPages;
  return {
    ...result,
    pages,
    pageSource:
      precontextPages.length > 0
        ? "precontext"
        : structuredPages.length > 0
          ? "structured"
          : "none",
  };
}

/** One page's OCR result, normalized for ingest. */
export interface OcrPageResult {
  pageNumber: number; // 0-indexed
  text: string;
  width?: number;
  height?: number;
  blocks: InterfazeBlock[];
}

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

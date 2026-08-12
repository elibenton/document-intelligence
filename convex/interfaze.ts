/**
 * Interfaze API client for Convex actions.
 *
 * Interfaze (https://interfaze.ai) is an OpenAI-compatible chat completions
 * API specialized for deterministic document tasks. A single call returns:
 *   - the model's answer (structured output via response_format json_schema)
 *   - a `precontext` array with raw specialist metadata — for PDFs, OCR
 *     sections/lines/words with bounding boxes and confidence scores.
 *
 * Two-step pipeline mirroring the previous Datalab integration:
 *   1. parse   — PDF → per-page markdown (model) + line blocks w/ bboxes (OCR)
 *   2. extract — structured data extraction via JSON schema
 */

const INTERFAZE_BASE = "https://api.interfaze.ai/v1";
const INTERFAZE_MODEL = "interfaze-beta";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Flattened block for storage (same shape the ingest mutations expect) */
export interface InterfazeBlock {
  id: string;
  block_type: string;
  text: string;
  page: number;
  bbox?: { x: number; y: number; width: number; height: number };
  confidence?: number;
}

export interface InterfazePageDimension {
  page: number;
  width: number;
  height: number;
}

export interface ParseResult {
  markdown: string; // pages joined by "\n---\n" (ingest splits on ---)
  json: InterfazeBlock[];
  pageDimensions: InterfazePageDimension[];
  page_count: number;
}

export interface ExtractResult {
  extraction_schema_json: string; // JSON string of extracted data
}

export interface ChatResult {
  content: string;
  precontext: PrecontextEntry[];
}

interface PrecontextEntry {
  name?: string;
  result?: unknown;
}

/** OCR precontext shapes (observed from the live API) */
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
interface OcrLine {
  text?: string;
  bounds?: OcrBounds;
  average_confidence?: number;
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

// ---------------------------------------------------------------------------
// Core chat completion call
// ---------------------------------------------------------------------------

type MessageContent =
  | { type: "text"; text: string }
  | { type: "file"; file: { filename: string; file_data: string } };

export async function chatCompletion(
  apiKey: string,
  options: {
    content: MessageContent[];
    systemPrompt?: string;
    responseSchema?: { name: string; schema: Record<string, unknown> };
    maxTokens?: number;
  }
): Promise<ChatResult> {
  const messages: Array<Record<string, unknown>> = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: options.content });

  const body: Record<string, unknown> = {
    model: INTERFAZE_MODEL,
    messages,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.responseSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: options.responseSchema.name,
        schema: options.responseSchema.schema,
      },
    };
  }

  const res = await fetch(`${INTERFAZE_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `Interfaze API error (${res.status}): ${await res.text()}`
    );
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    precontext: Array.isArray(data.precontext) ? data.precontext : [],
  };
}

export function fileContent(
  buffer: ArrayBuffer,
  filename: string,
  mimeType = "application/pdf"
): MessageContent {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return {
    type: "file",
    file: { filename, file_data: `data:${mimeType};base64,${base64}` },
  };
}

// ---------------------------------------------------------------------------
// OCR precontext → blocks
// ---------------------------------------------------------------------------

function boundsToBbox(
  bounds: OcrBounds | undefined
): InterfazeBlock["bbox"] | undefined {
  if (!bounds) return undefined;
  const points = [
    bounds.top_left,
    bounds.top_right,
    bounds.bottom_right,
    bounds.bottom_left,
  ].filter((p): p is Required<OcrPoint> =>
    typeof p?.x === "number" && typeof p?.y === "number"
  );
  if (points.length < 3) return undefined;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function collectOcrResults(
  precontext: PrecontextEntry[]
): OcrResult[] {
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
 * Observed shapes from the live API:
 *  - one `ocr` entry PER PAGE, in page order, each with page-local
 *    coordinates and per-page width/height — sometimes followed by a final
 *    combined entry covering the whole document (its height is the stacked
 *    sum of the page heights), which we drop;
 *  - a SINGLE `ocr` entry whose `sections` array has one section per page,
 *    with page-local coordinates.
 */
function ocrToPages(
  ocrs: OcrResult[]
): { sections: OcrSection[]; width?: number; height?: number }[] {
  if (ocrs.length === 0) return [];
  const total = ocrs.find((o) => typeof o.total_pages === "number")
    ?.total_pages;

  if (ocrs.length > 1) {
    // One entry per page; drop any trailing combined entry.
    const pageEntries =
      total && ocrs.length > total ? ocrs.slice(0, total) : ocrs;
    return pageEntries.map((o) => ({
      sections: o.sections ?? [],
      width: o.width,
      height: o.height,
    }));
  }

  const only = ocrs[0];
  const sections = only.sections ?? [];
  if (total && total > 1 && sections.length === total) {
    // One section per page.
    return sections.map((s) => ({
      sections: [s],
      width: only.width,
      height: only.height,
    }));
  }
  // Single page (or unknown mapping): everything on page 0.
  return [{ sections, width: only.width, height: only.height }];
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
        blocks.push({
          id: `p${pageIndex}_l${lineIndex++}`,
          block_type: "Line",
          text,
          page: pageIndex,
          bbox: boundsToBbox(line.bounds),
          confidence: line.average_confidence,
        });
      }
    }
  });

  return { blocks, pageDimensions, pageTexts };
}

// ---------------------------------------------------------------------------
// Step 1: Parse — PDF → per-page markdown + blocks
// ---------------------------------------------------------------------------

const PAGES_SCHEMA = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      description: "One entry per page of the document, in order.",
      items: {
        type: "object",
        properties: {
          page_number: {
            type: "integer",
            description: "1-based page number",
          },
          markdown: {
            type: "string",
            description:
              "The full text content of this page converted to clean markdown. Preserve headings, lists, and tables. Do not use --- horizontal rules.",
          },
        },
        required: ["page_number", "markdown"],
      },
    },
  },
  required: ["pages"],
};

export async function parse(
  pdfBuffer: ArrayBuffer,
  filename: string,
  apiKey: string
): Promise<ParseResult> {
  const { content, precontext } = await chatCompletion(apiKey, {
    content: [
      fileContent(pdfBuffer, filename),
      {
        type: "text",
        text: "Convert this document to clean markdown, one entry per page, preserving all text content in reading order.",
      },
    ],
    responseSchema: { name: "page_markdown", schema: PAGES_SCHEMA },
  });

  const ocrs = collectOcrResults(precontext);
  const { blocks, pageDimensions, pageTexts } = ocrToBlocks(ocrs);

  const totalPages = ocrs.find(
    (o) => typeof o.total_pages === "number"
  )?.total_pages;
  const pageCount = Math.max(totalPages ?? 0, pageTexts.length, 1);

  // Prefer the model's per-page markdown; fall back to raw OCR page text if
  // the model's page count disagrees with the OCR ground truth.
  let markdownPages: string[] = pageTexts;
  try {
    const parsed = JSON.parse(content) as {
      pages?: Array<{ page_number?: number; markdown?: string }>;
    };
    const modelPages = (parsed.pages ?? [])
      .slice()
      .sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0))
      .map((p) => p.markdown ?? "");
    if (modelPages.length === pageCount) {
      // ingest splits on "---" lines, so strip any the model produced anyway
      markdownPages = modelPages.map((m) =>
        m.replace(/^\s*-{3,}\s*$/gm, "").trim()
      );
    }
  } catch {
    // Not JSON (shouldn't happen with structured output) — keep OCR text.
  }

  return {
    markdown: markdownPages.join("\n---\n"),
    json: blocks,
    pageDimensions,
    page_count: pageCount,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Extract — structured data extraction via JSON schema
// ---------------------------------------------------------------------------

export async function extract(
  pdfBuffer: ArrayBuffer,
  filename: string,
  apiKey: string,
  pageSchema: Record<string, unknown>,
  options?: { pageRange?: string }
): Promise<ExtractResult> {
  const rangeClause = options?.pageRange
    ? ` Only consider pages ${options.pageRange} of the document.`
    : "";

  const { content } = await chatCompletion(apiKey, {
    content: [
      fileContent(pdfBuffer, filename),
      {
        type: "text",
        text: `Extract structured data from this document according to the response schema. Only include values actually present in the document.${rangeClause}`,
      },
    ],
    responseSchema: { name: "extraction", schema: pageSchema },
  });

  return { extraction_schema_json: content || "{}" };
}

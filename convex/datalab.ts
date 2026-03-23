/**
 * Datalab Marker API client for Convex actions.
 *
 * Three-step pipeline:
 *   1. Parse  (convert) — PDF → markdown + JSON blocks with bounding boxes
 *   2. Segment         — identify document sections with page ranges
 *   3. Extract          — structured data extraction via JSON schema
 *
 * All endpoints are async: submit → poll check_url → get results.
 */

const DATALAB_BASE = "https://www.datalab.to/api/v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw block from Datalab JSON output (recursive tree structure) */
export interface DatalabRawBlock {
  id?: string;
  block_type?: string;
  html?: string;
  bbox?: number[]; // [x0, y0, x1, y1]
  polygon?: number[][];
  children?: DatalabRawBlock[];
  section_hierarchy?: Record<string, string>;
  images?: Record<string, string>;
}

/** Flattened block for storage */
export interface DatalabBlock {
  id: string;
  block_type: string;
  text: string;
  html?: string;
  page: number;
  bbox?: { x: number; y: number; width: number; height: number };
}

/** Page dimensions from Datalab's Page block bbox */
export interface DatalabPageDimension {
  page: number;
  width: number;
  height: number;
}

export interface ParseResult {
  markdown: string;
  json: DatalabBlock[];
  pageDimensions: DatalabPageDimension[];
  page_count: number;
  checkpoint_id?: string;
  images?: Record<string, string>; // base64 images keyed by filename
}

export interface ExtractResult {
  extraction_schema_json: string; // JSON string of extracted data
  json: DatalabBlock[]; // source blocks for citation
  page_count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten Datalab's recursive block tree into a flat array.
 * Leaf blocks (no children) become entries; container blocks are traversed.
 * Page numbers are inferred from position (Datalab returns page-level children
 * when paginate=true — each top-level child is a page).
 */
function flattenBlocks(
  raw: DatalabRawBlock,
  pageNumber = 0,
): { blocks: DatalabBlock[]; pageDimensions: DatalabPageDimension[] } {
  const blocks: DatalabBlock[] = [];
  const pageDimensions: DatalabPageDimension[] = [];

  function walk(node: DatalabRawBlock, page: number) {
    const isPage = node.block_type === "Page";

    if (!node.children || node.children.length === 0) {
      const text = (node.html ?? "").replace(/<[^>]*>/g, "").trim();
      if (text || node.html) {
        let bbox: DatalabBlock["bbox"];
        if (node.bbox && node.bbox.length === 4) {
          bbox = {
            x: node.bbox[0],
            y: node.bbox[1],
            width: node.bbox[2] - node.bbox[0],
            height: node.bbox[3] - node.bbox[1],
          };
        }
        blocks.push({
          id: node.id ?? `block_${blocks.length}`,
          block_type: node.block_type ?? "Text",
          text,
          html: node.html,
          page,
          bbox,
        });
      }
    } else {
      for (const child of node.children) {
        walk(child, isPage ? page : page);
      }
    }
  }

  // Top-level: the root is a Document block whose children are Page blocks
  if (raw.children) {
    for (let i = 0; i < raw.children.length; i++) {
      const child = raw.children[i];
      const pg = child.block_type === "Page" ? i : pageNumber;

      // Capture page dimensions from the Page block's bbox
      if (child.block_type === "Page" && child.bbox && child.bbox.length === 4) {
        pageDimensions.push({
          page: pg,
          width: child.bbox[2] - child.bbox[0],
          height: child.bbox[3] - child.bbox[1],
        });
      }

      walk(child, pg);
    }
  } else {
    walk(raw, pageNumber);
  }

  return { blocks, pageDimensions };
}

async function pollUntilComplete(
  checkUrl: string,
  apiKey: string,
  maxPolls = 300,
  pollInterval = 2000
): Promise<Record<string, unknown>> {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollInterval));
    const res = await fetch(checkUrl, {
      headers: { "X-API-Key": apiKey },
    });
    if (!res.ok) {
      throw new Error(`Poll failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    if (data.status === "complete") {
      if (!data.success) {
        throw new Error(`Datalab processing failed: ${data.error || "unknown error"}`);
      }
      return data;
    }
    if (data.status === "failed") {
      throw new Error(`Datalab processing failed: ${data.error || "unknown error"}`);
    }
    // status is "processing" — keep polling
  }
  throw new Error("Datalab polling timed out");
}

// ---------------------------------------------------------------------------
// Step 1: Parse (convert)
// ---------------------------------------------------------------------------

export async function parse(
  pdfBuffer: ArrayBuffer,
  filename: string,
  apiKey: string,
  options?: {
    mode?: "fast" | "balanced" | "accurate";
    maxPages?: number;
    pageRange?: string;
    saveCheckpoint?: boolean;
  }
): Promise<ParseResult> {
  const form = new FormData();
  form.append("file", new Blob([pdfBuffer], { type: "application/pdf" }), filename);
  form.append("output_format", "json");
  form.append("mode", options?.mode ?? "balanced");
  form.append("paginate", "true");
  if (options?.maxPages) form.append("max_pages", String(options.maxPages));
  if (options?.pageRange) form.append("page_range", options.pageRange);
  if (options?.saveCheckpoint !== false) form.append("save_checkpoint", "true");

  const res = await fetch(`${DATALAB_BASE}/convert`, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Datalab convert submit failed: ${res.status} ${await res.text()}`);
  }

  const submitData = await res.json();
  const checkUrl = submitData.request_check_url;
  if (!checkUrl) {
    throw new Error("No request_check_url returned from Datalab convert");
  }

  const result = await pollUntilComplete(checkUrl, apiKey);

  // The `json` field is a recursive tree: Document → Page[] → Block[]
  // Flatten it into a simple array for storage.
  let blocks: DatalabBlock[] = [];
  let pageDimensions: DatalabPageDimension[] = [];
  const rawJson = result.json;
  if (rawJson && typeof rawJson === "object" && !Array.isArray(rawJson)) {
    const flattened = flattenBlocks(rawJson as DatalabRawBlock);
    blocks = flattened.blocks;
    pageDimensions = flattened.pageDimensions;
  } else if (Array.isArray(rawJson)) {
    blocks = (rawJson as DatalabRawBlock[]).map((b, i) => ({
      id: b.id ?? `block_${i}`,
      block_type: b.block_type ?? "Text",
      text: (b.html ?? "").replace(/<[^>]*>/g, "").trim(),
      html: b.html,
      page: 0,
      bbox: b.bbox && b.bbox.length === 4
        ? { x: b.bbox[0], y: b.bbox[1], width: b.bbox[2] - b.bbox[0], height: b.bbox[3] - b.bbox[1] }
        : undefined,
    }));
  }

  const markdown = (result.markdown as string) || blocks
    .map((b) => b.text)
    .filter(Boolean)
    .join("\n\n");

  return {
    markdown,
    json: blocks,
    pageDimensions,
    page_count: (result.page_count as number) || 0,
    checkpoint_id: result.checkpoint_id as string | undefined,
    images: result.images as Record<string, string> | undefined,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Extract
// ---------------------------------------------------------------------------

export async function extract(
  pdfBuffer: ArrayBuffer,
  filename: string,
  apiKey: string,
  pageSchema: Record<string, unknown>,
  options?: {
    checkpointId?: string;
    mode?: "fast" | "balanced" | "accurate";
    maxPages?: number;
    pageRange?: string;
  }
): Promise<ExtractResult> {
  const form = new FormData();

  if (options?.checkpointId) {
    form.append("checkpoint_id", options.checkpointId);
  } else {
    form.append("file", new Blob([pdfBuffer], { type: "application/pdf" }), filename);
  }

  form.append("page_schema", JSON.stringify(pageSchema));
  form.append("mode", options?.mode ?? "balanced");
  if (options?.maxPages) form.append("max_pages", String(options.maxPages));
  if (options?.pageRange) form.append("page_range", options.pageRange);

  const res = await fetch(`${DATALAB_BASE}/extract`, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Datalab extract submit failed: ${res.status} ${await res.text()}`);
  }

  const submitData = await res.json();
  const checkUrl = submitData.request_check_url;
  if (!checkUrl) {
    throw new Error("No request_check_url returned from Datalab extract");
  }

  const result = await pollUntilComplete(checkUrl, apiKey);

  return {
    extraction_schema_json: (result.extraction_schema_json as string) || "{}",
    json: (result.json as DatalabBlock[]) || [],
    page_count: (result.page_count as number) || 0,
  };
}

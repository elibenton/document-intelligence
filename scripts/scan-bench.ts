#!/usr/bin/env tsx
/**
 * Scan bench — measures what Interfaze actually gives us for a PDF, per variant.
 *
 *   npm run bench -- --dry-run              # ground truth only, no API calls
 *   npm run bench                           # default variants over test-corpus/
 *   npm run bench -- --variant=all
 *   npm run bench -- --variant=per-page --pages=20 file.pdf
 *
 * Every run appends a row to test-corpus/results/scan-bench.csv and writes a
 * full JSON record (including raw precontext) to test-corpus/results/raw/.
 * Those JSON files are the source for the checked-in test fixtures.
 *
 * Variants
 *   full         one completion, analysis-only schema — the proposed design.
 *                OCR + object geometry arrive via precontext.
 *   full-legacy  today's schema, which *requires* verbatim page text in the
 *                output. The A/B baseline: shows the truncation and the cost.
 *   task-ocr     `task: "ocr"` alone, no model. The cost and latency floor.
 *   per-page     rasterize locally, then one OCR task per page image.
 *                Answers "how long per page, really".
 */

import { readFile, writeFile, mkdir, readdir, appendFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Interfaze, responseFormat, inputs } from "interfaze";
import type { Precontext } from "interfaze";
import {
  ocrPrecontextToPages,
  interfazeCostUsd,
  type OcrPageResult,
} from "../convex/interfaze";
import { readTruth, rasterize, type PdfTruth } from "./lib/pdf";
import { checkGeometry, checkTextFidelity } from "./lib/checks";
import { diagnose, verdict, type Diagnosis } from "./lib/diagnose";

const execFileAsync = promisify(execFile);

const VARIANTS = ["full", "full-legacy", "task-ocr", "per-page"] as const;
type Variant = (typeof VARIANTS)[number];

const DEFAULT_VARIANTS: Variant[] = ["full", "task-ocr"];
const INTERFAZE_TIMEOUT_MS = 9 * 60 * 1000;
const DATA_URI_LIMIT_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Schemas — `full` is production's schema with `pages` removed; `full-legacy`
// is production's schema verbatim, so the comparison is honest.
// ---------------------------------------------------------------------------

const ANALYSIS_PROPERTIES = {
  title: { type: "string", description: "Document title as written, or a concise descriptive title" },
  summary: { type: "string", description: "A factual 2-3 sentence summary of the complete document" },
  date: { type: "string", description: "Primary date of the document (ISO if possible), or Unknown" },
  author: { type: "string", description: "Author or creator if identifiable, or Unknown" },
  language: { type: "string", description: "Primary document language" },
  source_language_code: { type: "string", description: "Primary document language as a lowercase ISO 639 code" },
  is_multilingual: { type: "boolean", description: "True when meaningful passages use more than one language" },
  primary_kind: { type: "string", description: "Concise lowercase semantic document kind" },
  tags: { type: "array", items: { type: "string" }, description: "3-6 concise lowercase topical tags" },
  graphic_objects: {
    type: "array",
    description:
      "Visually verified non-body-text objects: signatures, redactions, stamps or seals, handwriting, photographs, logos, charts, and other graphics. Empty if none.",
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
        "label", "description", "page_number",
        "top_left_x", "top_left_y", "bottom_right_x", "bottom_right_y", "confidence",
      ],
    },
  },
} as const;

const ANALYSIS_REQUIRED = Object.keys(ANALYSIS_PROPERTIES);

const SCHEMA_FULL = {
  type: "object",
  properties: { ...ANALYSIS_PROPERTIES },
  required: [...ANALYSIS_REQUIRED],
};

const SCHEMA_LEGACY = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      description:
        "Every page in the uploaded document, in file order, with complete verbatim OCR text in the original language. Never translate, summarize, merge, or omit pages.",
      items: {
        type: "object",
        properties: {
          page_number: { type: "integer", description: "1-based position of the page in the uploaded file" },
          text: { type: "string", description: "Complete verbatim OCR text for this page" },
        },
        required: ["page_number", "text"],
      },
    },
    ...ANALYSIS_PROPERTIES,
  },
  required: ["pages", ...ANALYSIS_REQUIRED],
};

const SYSTEM_FULL =
  "You are a meticulous document-understanding system. Perform OCR and object detection over the complete document in one pass. Return only visually verified graphic objects. Be factual, never infer a visual object from nearby text, and use Unknown when metadata is uncertain.";

const PROMPT_FULL =
  "Read every page of the complete document once. Return the requested metadata and every visually verified non-body-text object, including signatures, stamps, seals, redactions, and handwriting. Do not omit later pages.";

const PROMPT_LEGACY =
  "Read every page of the complete document once. Return each page's complete verbatim OCR text, the requested metadata, and every visually verified non-body-text object. Preserve Spanish and all other source languages exactly. Do not omit later pages.";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  variants: Variant[];
  dir: string;
  out: string;
  files: string[];
  concurrency: number;
  maxPages?: number;
  dryRun: boolean;
  bypassCache: boolean;
  reanalyze: boolean;
  /**
   * How the file reaches Interfaze. This is not cosmetic: the same PDF returns
   * a different OCR shape depending on transport, which is what produced a
   * 12-page document collapsed onto page 1 in production.
   *   data — inputs.file(base64 data URI)   20MB cap
   *   url  — inputs.file(https URL)          what production does today
   *   text — bare URL in the prompt text     80MB cap, per Interfaze docs
   */
  transport: "data" | "url" | "text";
  url?: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    variants: DEFAULT_VARIANTS,
    dir: "test-corpus",
    out: "test-corpus/results",
    files: [],
    concurrency: 6,
    dryRun: false,
    bypassCache: false,
    reanalyze: false,
    transport: "data",
  };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--reanalyze") opts.reanalyze = true;
    else if (arg === "--bypass-cache") opts.bypassCache = true;
    else if (arg.startsWith("--variant=")) {
      const value = arg.slice(10);
      opts.variants =
        value === "all" ? [...VARIANTS] : (value.split(",") as Variant[]);
    } else if (arg.startsWith("--dir=")) opts.dir = arg.slice(6);
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
    else if (arg.startsWith("--concurrency=")) opts.concurrency = Number(arg.slice(14));
    else if (arg.startsWith("--pages=")) opts.maxPages = Number(arg.slice(8));
    else if (arg.startsWith("--transport=")) {
      opts.transport = arg.slice(12) as Options["transport"];
    } else if (arg.startsWith("--url=")) opts.url = arg.slice(6);
    else if (!arg.startsWith("--")) opts.files.push(arg);
  }
  const unknown = opts.variants.filter((v) => !VARIANTS.includes(v));
  if (unknown.length) {
    throw new Error(
      `Unknown variant(s): ${unknown.join(", ")}. Valid: ${VARIANTS.join(", ")}, all`
    );
  }
  return opts;
}

/**
 * The key lives in the Convex deployment, not .env.local — fall back to
 * reading it from there so the bench works without extra setup.
 */
async function resolveApiKey(): Promise<string> {
  if (process.env.INTERFAZE_API_KEY) return process.env.INTERFAZE_API_KEY;
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["convex", "env", "get", "INTERFAZE_API_KEY"],
      { timeout: 60_000 }
    );
    const key = stdout.trim();
    if (key) return key;
  } catch {
    /* fall through to the explicit error */
  }
  throw new Error(
    "No INTERFAZE_API_KEY. Export it, or make sure `npx convex env get INTERFAZE_API_KEY` works."
  );
}

// ---------------------------------------------------------------------------
// Result record
// ---------------------------------------------------------------------------

interface RunResult {
  doc: string;
  variant: Variant;
  transport: string;
  bytes: number;
  truePages: number;
  ok: boolean;
  error?: string;
  totalMs: number;
  msPerPage: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  centsPerPage: number;
  vcache: boolean;
  contentParsed: boolean;
  precontextNames: string;
  ocrEntries: number;
  pagesFound: number;
  pageCountMatch: boolean;
  emptyPages: number;
  blocks: number;
  words: number;
  detections: number;
  geomChecked: number;
  geomViolations: number;
  geomKinds: string;
  branch: string;
  scaleFired: boolean;
  heuristicVerdict: string;
  fidelity: string;
}

const CSV_COLUMNS: (keyof RunResult | "runAt")[] = [
  "runAt", "doc", "variant", "transport", "bytes", "truePages", "ok", "error",
  "totalMs", "msPerPage", "promptTokens", "completionTokens", "costUsd",
  "centsPerPage", "vcache", "contentParsed", "precontextNames", "ocrEntries",
  "pagesFound", "pageCountMatch", "emptyPages", "blocks", "words", "detections",
  "geomChecked", "geomViolations", "geomKinds", "branch", "scaleFired",
  "heuristicVerdict", "fidelity",
];

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// ---------------------------------------------------------------------------
// Interfaze calls
// ---------------------------------------------------------------------------

interface CallOutcome {
  precontext: Precontext[];
  content: string;
  promptTokens: number;
  completionTokens: number;
  vcache: boolean;
  contentParsed: boolean;
  detections: number;
}

function usageOf(res: { usage?: { prompt_tokens?: number; completion_tokens?: number } }) {
  return {
    promptTokens: res.usage?.prompt_tokens ?? 0,
    completionTokens: res.usage?.completion_tokens ?? 0,
  };
}

function countDetections(content: string): number {
  try {
    const parsed = JSON.parse(content) as { graphic_objects?: unknown[] };
    return Array.isArray(parsed.graphic_objects) ? parsed.graphic_objects.length : 0;
  } catch {
    return 0;
  }
}

async function runFull(
  client: Interfaze,
  filePart: ReturnType<typeof inputs.file>,
  legacy: boolean
): Promise<CallOutcome> {
  const res = await client.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_FULL },
      {
        role: "user",
        content: [filePart, { type: "text", text: legacy ? PROMPT_LEGACY : PROMPT_FULL }],
      },
    ],
    max_tokens: 8_192,
    response_format: responseFormat(
      legacy ? SCHEMA_LEGACY : SCHEMA_FULL,
      "document_understanding"
    ),
  });
  const content = res.choices?.[0]?.message?.content ?? "";
  let contentParsed = true;
  try {
    JSON.parse(content);
  } catch {
    contentParsed = false;
  }
  return {
    precontext: res.precontext ?? [],
    content,
    ...usageOf(res),
    vcache: res.vcache,
    contentParsed,
    detections: contentParsed ? countDetections(content) : 0,
  };
}

/**
 * A task returns its payload on message.content as `{ result }`, not
 * precontext. The SDK's own helper falls back to the raw string when that
 * shape does not hold (`index.js:545`), so a non-JSON reply is a real
 * possibility and must be visible in the record rather than silently dropped.
 */
function taskResultToPrecontext(content: string): {
  precontext: Precontext[];
  shape: string;
} {
  if (!content.trim()) return { precontext: [], shape: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { precontext: [], shape: "not-json" };
  }
  const result =
    parsed && typeof parsed === "object" && "result" in parsed
      ? (parsed as { result: unknown }).result
      : parsed;
  if (result && typeof result === "object") {
    return { precontext: [{ name: "ocr", result }], shape: "object" };
  }
  return { precontext: [], shape: `json-${typeof result}` };
}

async function runTaskOcr(
  client: Interfaze,
  part: ReturnType<typeof inputs.file>
): Promise<CallOutcome> {
  const res = await client.chat.completions.create({
    task: "ocr",
    messages: [{ role: "user", content: [{ type: "text", text: "Extract all text and data." }, part] }],
  });
  const content = res.choices?.[0]?.message?.content ?? "";
  const { precontext, shape } = taskResultToPrecontext(content);
  if (precontext.length === 0) {
    console.log(`      task returned ${shape} (${content.length} chars) — not an OCR object`);
  }
  return {
    precontext,
    content,
    ...usageOf(res),
    vcache: res.vcache,
    contentParsed: precontext.length > 0,
    detections: 0,
  };
}

async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

async function runPerPage(
  client: Interfaze,
  data: Uint8Array,
  concurrency: number,
  maxPages: number | undefined,
  onPage: (pageNumber: number, ms: number) => void
): Promise<CallOutcome> {
  const all = await rasterize(data);
  const pages = maxPages ? all.slice(0, maxPages) : all;

  const results = await pool(pages, concurrency, async (page) => {
    const started = Date.now();
    const dataUri = await inputs.dataUrl(page.png, "image/png");
    const res = await client.chat.completions.create({
      task: "ocr",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extract all text and data." },
            inputs.image(dataUri),
          ],
        },
      ],
    });
    onPage(page.pageNumber, Date.now() - started);
    const content = res.choices?.[0]?.message?.content ?? "";
    const [entry] = taskResultToPrecontext(content).precontext;
    return { entry, ...usageOf(res), vcache: res.vcache };
  });

  return {
    // One `ocr` entry per page puts ocrToPages on its `per-result` branch,
    // which is the branch that needs no pagination guessing at all.
    precontext: results.flatMap((r) => (r.entry ? [r.entry] : [])),
    content: "",
    promptTokens: results.reduce((n, r) => n + r.promptTokens, 0),
    completionTokens: results.reduce((n, r) => n + r.completionTokens, 0),
    vcache: results.every((r) => r.vcache),
    contentParsed: results.every((r) => r.entry !== undefined),
    detections: 0,
  };
}

// ---------------------------------------------------------------------------
// One document × one variant
// ---------------------------------------------------------------------------

async function benchOne(
  client: Interfaze,
  file: string,
  data: Uint8Array,
  truth: PdfTruth,
  variant: Variant,
  opts: Options
): Promise<{ row: RunResult; precontext: Precontext[]; pages: OcrPageResult[]; diagnosis: Diagnosis; content: string }> {
  const doc = path.basename(file);
  const bytes = data.byteLength;
  const transport =
    variant === "per-page" ? "image-data-uri" : `file-${opts.transport}`;

  const row: RunResult = {
    doc, variant, transport, bytes,
    truePages: truth.pageCount,
    ok: false, totalMs: 0, msPerPage: 0,
    promptTokens: 0, completionTokens: 0, costUsd: 0, centsPerPage: 0,
    vcache: false, contentParsed: false, precontextNames: "", ocrEntries: 0,
    pagesFound: 0, pageCountMatch: false, emptyPages: 0, blocks: 0, words: 0,
    detections: 0, geomChecked: 0, geomViolations: 0, geomKinds: "",
    branch: "none", scaleFired: false, heuristicVerdict: "", fidelity: "",
  };

  const started = Date.now();
  let outcome: CallOutcome;
  try {
    if (variant === "per-page") {
      const perPageMs: number[] = [];
      outcome = await runPerPage(client, data, opts.concurrency, opts.maxPages, (_p, ms) =>
        perPageMs.push(ms)
      );
      if (perPageMs.length) {
        const sorted = [...perPageMs].sort((a, b) => a - b);
        console.log(
          `      per-page latency: median ${sorted[Math.floor(sorted.length / 2)]}ms  ` +
            `min ${sorted[0]}ms  max ${sorted[sorted.length - 1]}ms  (n=${sorted.length}, concurrency ${opts.concurrency})`
        );
      }
    } else {
      if (opts.transport !== "data" && !opts.url) {
        throw new Error(
          `--transport=${opts.transport} needs --url=<publicly fetchable URL> for this file`
        );
      }
      if (opts.transport === "data" && bytes > DATA_URI_LIMIT_BYTES) {
        throw new Error(
          `${(bytes / 1e6).toFixed(1)}MB exceeds the 20MB base64 limit — use --transport=text with --url`
        );
      }
      const part =
        opts.transport === "data"
          ? inputs.file(await inputs.dataUrl(data, "application/pdf"), {
              filename: doc,
            })
          : opts.transport === "url"
            ? inputs.file(opts.url!, { filename: doc })
            : // Bare URL in the prompt text — the 80MB path in Interfaze's docs.
              ({
                type: "text",
                text: `Read the document at this URL: ${opts.url}`,
              } as ReturnType<typeof inputs.file>);
      outcome =
        variant === "task-ocr"
          ? await runTaskOcr(client, part)
          : await runFull(client, part, variant === "full-legacy");
    }
  } catch (e) {
    row.totalMs = Date.now() - started;
    row.error = e instanceof Error ? e.message : String(e);
    return { row, precontext: [], pages: [], diagnosis: diagnose([]), content: "" };
  }

  row.totalMs = Date.now() - started;
  row.promptTokens = outcome.promptTokens;
  row.completionTokens = outcome.completionTokens;
  row.costUsd = interfazeCostUsd(outcome.promptTokens, outcome.completionTokens);
  row.vcache = outcome.vcache;
  row.contentParsed = outcome.contentParsed;
  row.detections = outcome.detections;

  const pages = ocrPrecontextToPages(outcome.precontext);
  const diagnosis = diagnose(outcome.precontext);
  const geometry = checkGeometry(pages);
  const fidelity = checkTextFidelity(pages, truth);

  const scored = opts.maxPages ?? truth.pageCount;
  row.ok = pages.length > 0;
  row.msPerPage = Math.round(row.totalMs / Math.max(1, scored));
  row.centsPerPage = Number(((row.costUsd * 100) / Math.max(1, scored)).toFixed(4));
  row.precontextNames = diagnosis.precontextNames.join("|");
  row.ocrEntries = diagnosis.ocrEntries;
  row.pagesFound = pages.length;
  row.pageCountMatch = opts.maxPages
    ? pages.length === opts.maxPages
    : pages.length === truth.pageCount;
  row.emptyPages = pages.filter((p) => !p.text.trim()).length;
  row.blocks = pages.reduce((n, p) => n + p.blocks.length, 0);
  row.words = pages.reduce(
    (n, p) => n + p.blocks.reduce((m, b) => m + (b.words?.length ?? 0), 0),
    0
  );
  row.geomChecked = geometry.checked;
  row.geomViolations = geometry.violations;
  row.geomKinds = Object.entries(geometry.byKind)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  row.branch = diagnosis.branch;
  row.scaleFired = diagnosis.scaleFired;
  row.heuristicVerdict = verdict(diagnosis);
  row.fidelity = fidelity.applicable
    ? `${(fidelity.ratio * 100).toFixed(1)}%`
    : `n/a (${fidelity.reason})`;

  if (geometry.examples.length) {
    for (const example of geometry.examples) console.log(`      ! ${example}`);
  }
  if (fidelity.applicable && fidelity.worstPages.length) {
    const worst = fidelity.worstPages[0];
    console.log(
      `      worst page ${worst.pageNumber}: ${(worst.ratio * 100).toFixed(1)}% ` +
        `(native ${worst.native} words, ocr ${worst.ocr})`
    );
  }

  return { row, precontext: outcome.precontext, pages, diagnosis, content: outcome.content };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function collectFiles(opts: Options): Promise<string[]> {
  if (opts.files.length) return opts.files;
  if (!existsSync(opts.dir)) return [];
  const entries = await readdir(opts.dir);
  return entries
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort()
    .map((f) => path.join(opts.dir, f));
}

/**
 * Re-run the checkers over precontext already on disk. No API calls, no cost.
 *
 * The checkers are as likely to be wrong as the provider is — the first bench
 * run flagged 786 "violations" that turned out to be a too-tight tolerance.
 * Being able to fix a checker and re-score the whole corpus for free is what
 * keeps that from being an expensive mistake.
 */
async function reanalyze(opts: Options) {
  const rawDir = path.join(opts.out, "raw");
  if (!existsSync(rawDir)) {
    console.error(`Nothing to re-analyze: ${rawDir} does not exist.`);
    process.exit(1);
  }
  const records = (await readdir(rawDir)).filter((f) => f.endsWith(".json")).sort();
  console.log(`\nRe-analyzing ${records.length} saved record(s) — no API calls\n`);

  for (const record of records) {
    const saved = JSON.parse(
      await readFile(path.join(rawDir, record), "utf8")
    ) as { row: RunResult; precontext: Precontext[] };
    const precontext = saved.precontext ?? [];
    const pages = ocrPrecontextToPages(precontext);
    const diagnosis = diagnose(precontext);
    const geometry = checkGeometry(pages);

    // Fidelity needs the original bytes; recompute when the PDF is still here.
    let fidelity = "n/a (source pdf not found)";
    const pdfPath = path.join(opts.dir, `${record.split("--")[0]}.pdf`);
    if (existsSync(pdfPath)) {
      const truth = await readTruth(new Uint8Array(await readFile(pdfPath)));
      const report = checkTextFidelity(pages, truth);
      fidelity = report.applicable
        ? `${(report.ratio * 100).toFixed(1)}%`
        : `n/a (${report.reason})`;
    }

    const before = saved.row.geomViolations;
    console.log(
      `${record.replace(".json", "").padEnd(34)} ` +
        `pages ${pages.length}  geom ${geometry.violations}/${geometry.checked}` +
        `${before !== geometry.violations ? ` (was ${before})` : ""}  ` +
        `fidelity ${fidelity}  [${verdict(diagnosis)}]`
    );
    for (const example of geometry.examples) console.log(`    ! ${example}`);
  }
  console.log("");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.reanalyze) return reanalyze(opts);
  const files = await collectFiles(opts);

  if (files.length === 0) {
    console.error(
      `No PDFs found in ${opts.dir}/. Drop files there (see test-corpus/README.md) or pass paths directly.`
    );
    process.exit(1);
  }

  await mkdir(path.join(opts.out, "raw"), { recursive: true });
  const csvPath = path.join(opts.out, "scan-bench.csv");
  if (!existsSync(csvPath)) {
    await writeFile(csvPath, CSV_COLUMNS.join(",") + "\n");
  }

  const client = opts.dryRun
    ? null
    : new Interfaze({
        apiKey: await resolveApiKey(),
        timeout: INTERFAZE_TIMEOUT_MS,
        maxRetries: 1, // a retry would hide the latency we're here to measure
        bypassCache: opts.bypassCache,
      });

  console.log(
    `\n${files.length} document(s) × ${opts.dryRun ? "ground truth only" : opts.variants.join(", ")}\n`
  );

  for (const file of files) {
    const data = new Uint8Array(await readFile(file));
    const { size } = await stat(file);
    let truth: PdfTruth;
    try {
      truth = await readTruth(data);
    } catch (e) {
      console.log(`${path.basename(file)}  ✗ unreadable: ${e instanceof Error ? e.message : e}`);
      continue;
    }

    console.log(
      `${path.basename(file)}  ${truth.pageCount}pp  ${(size / 1e6).toFixed(1)}MB  ` +
        `native-text ${(truth.visibleTextRatio * 100).toFixed(0)}%  ` +
        `oracle ${truth.usableAsOracle ? "yes" : "no"}`
    );
    if (size > DATA_URI_LIMIT_BYTES) {
      console.log(`   ⚠ over 20MB — needs the URL transport, base64 variants will fail`);
    }
    if (opts.dryRun) continue;

    for (const variant of opts.variants) {
      process.stdout.write(`   ${variant.padEnd(12)}`);
      const { row, precontext, pages, diagnosis, content: outcomeContent } = await benchOne(
        client!,
        file,
        data,
        truth,
        variant,
        opts
      );

      if (row.error) {
        console.log(`✗ ${row.error}`);
      } else {
        console.log(
          `${(row.totalMs / 1000).toFixed(1)}s  ${row.msPerPage}ms/pp  ` +
            `$${row.costUsd.toFixed(4)} (${row.centsPerPage}¢/pp)  ` +
            `pages ${row.pagesFound}/${row.truePages}${row.pageCountMatch ? "" : " ✗"}  ` +
            `geom ${row.geomViolations}/${row.geomChecked}  ` +
            `fidelity ${row.fidelity}  [${row.heuristicVerdict}]`
        );
      }

      await appendFile(
        csvPath,
        CSV_COLUMNS.map((c) =>
          csvCell(c === "runAt" ? new Date().toISOString() : row[c])
        ).join(",") + "\n"
      );

      const stem = `${path.basename(file, ".pdf")}--${variant}`;
      await writeFile(
        path.join(opts.out, "raw", `${stem}.json`),
        JSON.stringify(
          {
            row,
            diagnosis,
            truth: {
              pageCount: truth.pageCount,
              visibleTextRatio: truth.visibleTextRatio,
              usableAsOracle: truth.usableAsOracle,
            },
            pageSummary: pages.map((p) => ({
              pageNumber: p.pageNumber,
              width: p.width,
              height: p.height,
              chars: p.text.length,
              blocks: p.blocks.length,
            })),
            precontext,
            content: outcomeContent,
          },
          null,
          2
        )
      );
    }
    console.log("");
  }

  console.log(`Results → ${csvPath}`);
  console.log(`Raw     → ${path.join(opts.out, "raw")}/\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * TOC bench — where should the table of contents come from?
 *
 *   npm run bench:toc -- --arm=native                 # free, no API calls
 *   npm run bench:toc -- --arm=detect --limit=5       # the probe (costs money)
 *   npm run bench:toc -- --arm=analyze --repeat=3     # baseline + its variance
 *   npm run bench:toc -- --arm=native,analyze --doc=<documentId>
 *
 * Runs against documents *already uploaded* to the deployment, not local
 * fixtures: the input under test is the stored OCR page text, which only exists
 * there. Files come through the same storage URL production uses and are cached
 * under test-corpus/uploaded/.
 *
 * Arms
 *   native   pdf.js embedded outline, falling back to font-size headings over
 *            the native text layer. No API call, no cost, and available before
 *            OCR finishes. Only works on born-digital PDFs — which is itself a
 *            finding, since it bounds how much of the corpus this can serve.
 *   detect   `task: "object_detection"` and `task: "gui_detection"`. The
 *            hypothesis: a cheap specialist run concurrently with OCR yields
 *            document structure. Interfaze does not publish these tasks' output
 *            schemas, so PHASE 0 DUMPS THEM RAW AND JUDGES NOTHING. Read the
 *            JSON before building any scoring on top of it.
 *   analyze  today's method — the full document text through the Analyze
 *            completion — re-run `--repeat` times to measure how much it agrees
 *            with itself. It produced 5, 6, and 6 entries on three runs over one
 *            document in production, so this is not a formality.
 *
 * Scoring is against `--reference`:
 *   stored (default)  the TOC Analyze already wrote on the document. This
 *                     measures AGREEMENT, not accuracy — the reference is one
 *                     of the things being tested.
 *   file              test-corpus/toc-reference/<documentId>.json, hand-checked.
 *                     The only mode whose numbers are accuracy.
 *
 * Results append to test-corpus/results/toc-bench.csv; every raw response is
 * written to test-corpus/results/raw/toc/.
 */

import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Interfaze, inputs } from "interfaze";
import { loadPdf, rasterize } from "./lib/pdf";
import {
  headingsFromGeometry,
  score,
  selfAgreement,
  type GeometryItem,
  type TocEntry,
  type TocScore,
} from "./lib/toc";
import {
  loadDocuments,
  loadPageTexts,
  localCopy,
  fileUrl,
  deploymentEnv,
  type CorpusDocument,
} from "./lib/corpus";
import { analyzeDocumentText } from "../convex/interfaze";
import {
  analyzeSystemPrompt,
  buildAnalyzePrompt,
  buildDocumentUnderstandingSchema,
  type CategoryDef,
} from "../convex/analyzePrompt";

// Standalone script, no Convex ctx — mirrors the seeded defaults rather than
// reading the live documentCategories table.
const CATEGORIES: CategoryDef[] = [
  { key: "legal", label: "Legal", description: "Instruments with legal force or filed in a legal proceeding — pleadings, orders, contracts, deeds, subpoenas." },
  { key: "government", label: "Government", description: "Records a public agency produced or received while administering something — permits, inspection reports, agency correspondence, public-records responses." },
  { key: "business", label: "Business", description: "Records internal to a private organization — invoices, memos, financial statements, board minutes, personnel files." },
  { key: "published", label: "Published", description: "Anything issued to a general audience — news articles, press releases, books, academic papers, web pages." },
];

const ARMS = ["native", "detect", "analyze"] as const;
type Arm = (typeof ARMS)[number];

const OUT_DIR = "test-corpus/results";
const RAW_DIR = path.join(OUT_DIR, "raw", "toc");
const REFERENCE_DIR = "test-corpus/toc-reference";
const INTERFAZE_TIMEOUT_MS = 9 * 60 * 1000;

const CSV_COLUMNS = [
  "timestamp",
  "documentId",
  "name",
  "pages",
  "arm",
  "run",
  "source",
  "entries",
  "referenceCount",
  "matched",
  "recall",
  "precision",
  "f1",
  "pageExact",
  "pageWithin1",
  "levelExact",
  "selfAgreement",
  "ms",
  "note",
] as const;

interface Options {
  arms: Arm[];
  limit: number;
  repeat: number;
  documentIds: string[];
  reference: "stored" | "file";
  bypassCache: boolean;
  /** Pages to rasterize for the detect arm; 0 sends the PDF as-is. */
  detectPages: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    arms: ["native"],
    limit: 10,
    repeat: 1,
    reference: "stored",
    bypassCache: false,
    detectPages: 2,
    documentIds: [],
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "arm") {
      options.arms = value.split(",").map((v) => {
        if (!ARMS.includes(v as Arm)) throw new Error(`unknown arm: ${v}`);
        return v as Arm;
      });
    } else if (key === "limit") options.limit = Number(value);
    else if (key === "repeat") options.repeat = Number(value);
    else if (key === "doc") options.documentIds = value.split(",").filter(Boolean);
    else if (key === "reference") options.reference = value as "stored" | "file";
    else if (key === "bypass-cache") options.bypassCache = true;
    else if (key === "detect-pages") options.detectPages = Number(value);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Arm: native — embedded outline, then font-size headings. Free.
// ---------------------------------------------------------------------------

interface OutlineNode {
  title: string;
  dest: unknown;
  items?: OutlineNode[];
}

/**
 * A PDF's own bookmarks. When present this is not a heuristic at all — it is
 * the structure the document's author published, resolved to real page indices.
 */
async function outlineToc(
  pdf: Awaited<ReturnType<typeof loadPdf>>["pdf"]
): Promise<TocEntry[]> {
  const outline = (await pdf.getOutline()) as OutlineNode[] | null;
  if (!outline || outline.length === 0) return [];

  const entries: TocEntry[] = [];
  const walk = async (nodes: OutlineNode[], level: number) => {
    for (const node of nodes) {
      let page: number | null = null;
      try {
        const dest =
          typeof node.dest === "string"
            ? await pdf.getDestination(node.dest)
            : (node.dest as unknown[] | null);
        if (Array.isArray(dest) && dest[0]) {
          page = (await pdf.getPageIndex(dest[0] as never)) + 1;
        }
      } catch {
        // A destination we cannot resolve is a bookmark we cannot place. Drop
        // it rather than guess a page — a TOC entry that jumps to the wrong
        // place is worse than one that is absent.
      }
      if (page !== null && node.title?.trim()) {
        entries.push({ title: node.title.trim(), level, page });
      }
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk(outline, 1);
  return entries;
}

async function geometryItems(
  pdf: Awaited<ReturnType<typeof loadPdf>>["pdf"]
): Promise<GeometryItem[]> {
  const items: GeometryItem[] = [];
  for (let index = 0; index < pdf.numPages; index++) {
    const page = await pdf.getPage(index + 1);
    try {
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const transform = item.transform as number[];
        items.push({
          text: item.str,
          size: Math.abs(transform[3]) || Math.abs(transform[0]) || 0,
          page: index + 1,
          order: transform[5] ?? 0,
          bold: /bold|black|heavy/i.test(String(item.fontName ?? "")),
        });
      }
    } finally {
      page.cleanup();
    }
  }
  return items;
}

/**
 * Adjacent text items at the same size on the same line are one heading split
 * across draw calls ("Findings" + " of Fact"). Joining them before detection
 * keeps a real heading from being scored as three fragments.
 */
function mergeLines(items: GeometryItem[]): GeometryItem[] {
  const merged: GeometryItem[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.page === item.page &&
      Math.abs(previous.order - item.order) < 1 &&
      Math.abs(previous.size - item.size) < 0.5
    ) {
      previous.text = `${previous.text}${item.text.startsWith(" ") ? "" : " "}${item.text}`;
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

async function runNative(
  bytes: Uint8Array
): Promise<{ toc: TocEntry[]; source: string }> {
  const { pdf } = await loadPdf(bytes);
  try {
    const outline = await outlineToc(pdf);
    if (outline.length > 0) return { toc: outline, source: "outline" };
    const items = mergeLines(await geometryItems(pdf));
    if (items.length === 0) return { toc: [], source: "no-text-layer" };
    const headings = headingsFromGeometry(items);
    return { toc: headings, source: headings.length ? "font-size" : "no-headings" };
  } finally {
    await pdf.destroy();
  }
}

// ---------------------------------------------------------------------------
// Arm: detect — the hypothesis under test. Phase 0 only dumps.
// ---------------------------------------------------------------------------

const DETECT_TASKS = ["object_detection", "gui_detection"] as const;

interface DetectResult {
  task: string;
  page?: number;
  ms: number;
  raw: unknown;
  error?: string;
}

/**
 * Both detection tasks refuse a PDF outright — `{"error": "File is not an
 * Image."}`, returned in under a second for zero tokens. So the hypothesis
 * cannot be tested document-at-a-time the way OCR can: pages have to be
 * rasterized locally and sent one image at a time, which is a per-page call
 * plus local rasterization rather than one cheap call alongside OCR.
 *
 * That cost shape is part of the finding, so the PDF attempt stays in the bench
 * as the record of why the image path exists.
 */
async function runDetect(
  client: Interfaze,
  document: CorpusDocument,
  url: string,
  images: { pageNumber: number; png: Buffer }[]
): Promise<DetectResult[]> {
  const results: DetectResult[] = [];
  const call = async (task: string, content: unknown[], page?: number) => {
    const startedAt = Date.now();
    try {
      const response = await client.chat.completions.create({
        task,
        messages: [{ role: "user", content }],
      } as never);
      results.push({ task, page, ms: Date.now() - startedAt, raw: response });
    } catch (error) {
      results.push({
        task,
        page,
        ms: Date.now() - startedAt,
        raw: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  for (const task of DETECT_TASKS) {
    if (images.length === 0) {
      await call(task, [
        { type: "file", file: { file_data: url, filename: document.name } },
      ]);
      continue;
    }
    for (const image of images) {
      const dataUri = await inputs.dataUrl(image.png, "image/png");
      await call(task, [inputs.image(dataUri)], image.pageNumber + 1);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Arm: analyze — today's method, over the stored page text.
// ---------------------------------------------------------------------------

async function runAnalyze(
  apiKey: string,
  pageTexts: string[],
  bypassCache: boolean
): Promise<{ toc: TocEntry[]; raw: unknown }> {
  const result = await analyzeDocumentText(pageTexts, apiKey, {
    systemPrompt: analyzeSystemPrompt(false),
    prompt: buildAnalyzePrompt({ csv: false, kindNames: [], categories: CATEGORIES }),
    responseSchema: {
      name: "document_analysis",
      schema: buildDocumentUnderstandingSchema(CATEGORIES.map((c) => c.key)),
    },
    // Repeats exist to measure run-to-run variance; the cache would return the
    // first answer forever and report perfect agreement.
    bypassCache,
  });
  const parsed = JSON.parse(result.content) as {
    table_of_contents?: { title?: string; level?: number; page?: number }[];
  };
  const toc = (parsed.table_of_contents ?? [])
    .filter((entry) => entry.title?.trim() && typeof entry.page === "number")
    .map((entry) => ({
      title: entry.title!.trim(),
      level: entry.level ?? 1,
      page: entry.page!,
    }));
  return { toc, raw: parsed };
}

// ---------------------------------------------------------------------------

async function referenceFor(
  document: CorpusDocument,
  mode: "stored" | "file"
): Promise<TocEntry[] | null> {
  if (mode === "file") {
    const file = path.join(REFERENCE_DIR, `${document._id}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, "utf8")) as TocEntry[];
  }
  return document.tableOfContents ?? null;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function fixed(value: number | undefined): string {
  return value === undefined ? "" : value.toFixed(3);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(RAW_DIR, { recursive: true });
  const csvPath = path.join(OUT_DIR, "toc-bench.csv");
  if (!existsSync(csvPath)) await writeFile(csvPath, CSV_COLUMNS.join(",") + "\n");

  const allDocuments = await loadDocuments();
  const candidates = allDocuments
    .filter((doc) =>
      options.documentIds.length ? options.documentIds.includes(doc._id) : true
    )
    .filter((doc) => doc.mediaType !== "audio" && doc.mediaType !== "video")
    // Documents with a stored TOC first: in the default reference mode they are
    // the only ones that can be scored at all.
    .sort((a, b) => (b.tableOfContents?.length ?? 0) - (a.tableOfContents?.length ?? 0))
    .slice(0, options.limit);

  if (candidates.length === 0) {
    console.error("No matching documents in the deployment.");
    process.exit(1);
  }

  const needsApi = options.arms.some((arm) => arm !== "native");
  const pageTexts = options.arms.includes("analyze")
    ? await loadPageTexts()
    : new Map<string, string[]>();
  const client = needsApi
    ? new Interfaze({
        apiKey: await deploymentEnv("INTERFAZE_API_KEY"),
        timeout: INTERFAZE_TIMEOUT_MS,
        maxRetries: 1, // a retry would hide the latency this is here to measure
      })
    : null;
  const apiKey = options.arms.includes("analyze")
    ? await deploymentEnv("INTERFAZE_API_KEY")
    : "";

  console.log(
    `\n${candidates.length} document(s) × ${options.arms.join(", ")}` +
      `  reference=${options.reference}\n`
  );

  const rows: string[] = [];
  const emit = (row: Record<string, unknown>) => {
    rows.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  };

  for (const document of candidates) {
    const reference = await referenceFor(document, options.reference);
    const label = (document.displayName || document.name).slice(0, 46);
    console.log(
      `${label}  ${document.pageCount ?? "?"}pp  ` +
        `reference ${reference ? `${reference.length} entries` : "none"}`
    );

    const report = (
      arm: string,
      run: number,
      toc: TocEntry[],
      source: string,
      ms: number,
      note = ""
    ) => {
      const scored: TocScore | null = reference ? score(reference, toc) : null;
      emit({
        timestamp: new Date().toISOString(),
        documentId: document._id,
        name: document.name,
        pages: document.pageCount ?? "",
        arm,
        run,
        source,
        entries: toc.length,
        referenceCount: reference?.length ?? "",
        matched: scored?.matched ?? "",
        recall: fixed(scored?.recall),
        precision: fixed(scored?.precision),
        f1: fixed(scored?.f1),
        pageExact: fixed(scored?.pageExact),
        pageWithin1: fixed(scored?.pageWithin1),
        levelExact: fixed(scored?.levelExact),
        selfAgreement: "",
        ms,
        note,
      });
      console.log(
        `   ${arm.padEnd(8)} ${String(toc.length).padStart(3)} entries  ` +
          `${source.padEnd(13)} ${String(ms).padStart(6)}ms  ` +
          (scored
            ? `recall ${(scored.recall * 100).toFixed(0)}%  ` +
              `precision ${(scored.precision * 100).toFixed(0)}%  ` +
              `page-exact ${(scored.pageExact * 100).toFixed(0)}%`
            : "unscored") +
          (note ? `  ${note}` : "")
      );
    };

    for (const arm of options.arms) {
      if (arm === "native") {
        const copy = await localCopy(document);
        if (!copy) {
          report("native", 1, [], "no-file", 0, "file missing from storage");
          continue;
        }
        const startedAt = Date.now();
        try {
          const { toc, source } = await runNative(copy.bytes);
          report("native", 1, toc, source, Date.now() - startedAt);
          await writeFile(
            path.join(RAW_DIR, `${document._id}--native.json`),
            JSON.stringify({ document: document.name, source, toc }, null, 2)
          );
        } catch (error) {
          report(
            "native",
            1,
            [],
            "error",
            Date.now() - startedAt,
            error instanceof Error ? error.message : String(error)
          );
        }
      }

      if (arm === "detect") {
        const url = await fileUrl(document.storageId);
        if (!url) {
          report("detect", 1, [], "no-file", 0, "file missing from storage");
          continue;
        }
        // Rasterize locally first: the tasks reject PDFs, so an image per page
        // is the only shape they accept.
        let images: { pageNumber: number; png: Buffer }[] = [];
        if (options.detectPages > 0) {
          const copy = await localCopy(document);
          if (copy) {
            const pageNumbers = Array.from(
              { length: options.detectPages },
              (_, i) => i
            );
            try {
              images = await rasterize(copy.bytes, pageNumbers);
            } catch {
              images = [];
            }
          }
        }
        const results = await runDetect(client!, document, url, images);
        await writeFile(
          path.join(RAW_DIR, `${document._id}--detect.json`),
          JSON.stringify({ document: document.name, results }, null, 2)
        );
        for (const result of results) {
          // Phase 0 judges nothing: these tasks' output shapes are undocumented,
          // so the only honest output is the raw response and where it landed.
          report(
            "detect",
            1,
            [],
            result.page ? `${result.task} p${result.page}` : result.task,
            result.ms,
            result.error
              ? `ERROR ${result.error.slice(0, 80)}`
              : `raw → ${document._id}--detect.json`
          );
        }
      }

      if (arm === "analyze") {
        const texts = pageTexts.get(document._id);
        if (!texts?.length) {
          report("analyze", 1, [], "no-pages", 0, "no stored page text");
          continue;
        }
        const runs: TocEntry[][] = [];
        for (let run = 1; run <= options.repeat; run++) {
          const startedAt = Date.now();
          try {
            const { toc, raw } = await runAnalyze(
              apiKey,
              texts,
              options.repeat > 1 || options.bypassCache
            );
            runs.push(toc);
            report("analyze", run, toc, "full-text", Date.now() - startedAt);
            await writeFile(
              path.join(RAW_DIR, `${document._id}--analyze-${run}.json`),
              JSON.stringify(raw, null, 2)
            );
          } catch (error) {
            report(
              "analyze",
              run,
              [],
              "error",
              Date.now() - startedAt,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
        if (runs.length > 1) {
          const agreement = selfAgreement(runs);
          emit({
            timestamp: new Date().toISOString(),
            documentId: document._id,
            name: document.name,
            pages: document.pageCount ?? "",
            arm: "analyze",
            run: "all",
            source: "self-agreement",
            entries: runs.map((r) => r.length).join("/"),
            selfAgreement: agreement.toFixed(3),
            note: "mean pairwise F1 across repeats",
          });
          console.log(
            `   ${"analyze".padEnd(8)} self-agreement ${(agreement * 100).toFixed(0)}%` +
              `  (entry counts ${runs.map((r) => r.length).join(", ")})`
          );
        }
      }
    }
  }

  await appendFile(csvPath, rows.join("\n") + "\n");
  console.log(`\n${rows.length} row(s) → ${csvPath}`);
  console.log(`raw responses → ${RAW_DIR}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

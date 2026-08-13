/**
 * One-off: run the Analyze structured output over saved OCR precontext.
 * No re-scan, no upload — reads test-corpus/results/raw/*--task-ocr.json.
 *
 *   npx tsx scripts/tmp-analyze.ts "test-corpus/results/raw/<name>--task-ocr.json"
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ocrPrecontextToPages, analyzeDocumentText } from "../convex/interfaze";
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

const file = process.argv[2];
const raw = JSON.parse(readFileSync(file, "utf8"));
const pages = ocrPrecontextToPages(raw.precontext);
const pageTexts = pages.map((page) => page.text);
console.error(`pages: ${pageTexts.length}, chars: ${pageTexts.join("").length}`);

const apiKey =
  process.env.INTERFAZE_API_KEY ||
  execFileSync("npx", ["convex", "env", "get", "INTERFAZE_API_KEY"], {
    encoding: "utf8",
  }).trim();

const res = await analyzeDocumentText(pageTexts, apiKey, {
  systemPrompt: analyzeSystemPrompt(false),
  prompt: buildAnalyzePrompt({ csv: false, kindNames: ["report", "contract"], categories: CATEGORIES }),
  responseSchema: {
    name: "document_analysis",
    schema: buildDocumentUnderstandingSchema(CATEGORIES.map((c) => c.key)),
  },
  bypassCache: true,
});
console.log(JSON.stringify(JSON.parse(res.content), null, 2));

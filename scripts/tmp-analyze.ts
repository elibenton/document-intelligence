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
  DOCUMENT_UNDERSTANDING_SCHEMA,
} from "../convex/analyzePrompt";

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
  prompt: buildAnalyzePrompt({ csv: false, kindNames: ["report", "contract"] }),
  responseSchema: {
    name: "document_analysis",
    schema: DOCUMENT_UNDERSTANDING_SCHEMA,
  },
  bypassCache: true,
});
console.log(JSON.stringify(JSON.parse(res.content), null, 2));

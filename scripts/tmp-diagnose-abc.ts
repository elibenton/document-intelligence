/**
 * Diagnostic: capture the RAW model JSON (kind_evidence + primary_kind) for
 * an already-classified document, without writing to the DB. Answers: is the
 * model finding a specific form number/name and discarding it in favor of a
 * generic bucket, or never seeing one at all?
 *
 *   npx tsx scripts/tmp-diagnose-abc.ts <documentId>
 */
import { execFileSync } from "node:child_process";
import { analyzeDocumentText } from "../convex/interfaze";
import {
  analyzeSystemPrompt,
  buildAnalyzePrompt,
  buildDocumentUnderstandingSchema,
} from "../convex/analyzePrompt";

const documentId = process.argv[2];
if (!documentId) throw new Error("usage: tmp-diagnose-abc.ts <documentId>");

function convexRun(fn: string, args: object) {
  const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    encoding: "utf8",
  });
  return JSON.parse(out);
}

const pages: { pageNumber: number; text: string }[] = convexRun(
  "pages:textByDocument",
  { documentId }
);
const pageTexts = pages
  .sort((a, b) => a.pageNumber - b.pageNumber)
  .map((p) => p.text);
console.error(`pages: ${pageTexts.length}, chars: ${pageTexts.join("").length}`);

const kinds: { name: string }[] = convexRun("kinds:list", {});
const categories: { key: string; label: string; description: string }[] = convexRun(
  "documentCategories:list",
  {}
);

const apiKey =
  process.env.INTERFAZE_API_KEY ||
  execFileSync("npx", ["convex", "env", "get", "INTERFAZE_API_KEY"], {
    encoding: "utf8",
  }).trim();

const res = await analyzeDocumentText(pageTexts, apiKey, {
  systemPrompt: analyzeSystemPrompt(false),
  prompt: buildAnalyzePrompt({
    csv: false,
    kindNames: kinds.map((k) => k.name),
    categories,
  }),
  responseSchema: {
    name: "document_analysis",
    schema: buildDocumentUnderstandingSchema(categories.map((c) => c.key)),
  },
  bypassCache: true,
});

const parsed = JSON.parse(res.content);
console.log(
  JSON.stringify(
    {
      kind_evidence: parsed.kind_evidence,
      primary_kind: parsed.primary_kind,
      primary_category: parsed.primary_category,
      document_types: parsed.document_types,
    },
    null,
    2
  )
);

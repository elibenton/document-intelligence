#!/usr/bin/env tsx
/**
 * Collapse the saved bench records into the findings table.
 *
 *   npx tsx scripts/summarize-variants.ts
 *
 * Offline and free — it only reads test-corpus/results/raw/. `markers` counts
 * how many of the per-page "PAGE MARKER n" strings survived the round trip,
 * which is how truncation shows up on the scale variants.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const RAW = "test-corpus/results/raw";

interface Saved {
  row: { doc: string; truePages: number; costUsd: number; completionTokens: number };
  precontext: { name: string; result?: { extracted_text?: string } }[];
  content: string;
}

function textOf(saved: Saved): string {
  return saved.precontext
    .map((entry) => entry.result?.extracted_text ?? "")
    .join("\n");
}

async function main() {
  const files = (await readdir(RAW)).filter((f) => f.endsWith("--task-ocr.json")).sort();
  const rows: string[][] = [];

  for (const file of files) {
    const saved = JSON.parse(await readFile(path.join(RAW, file), "utf8")) as Saved;
    const text = textOf(saved);
    const markers = new Set(
      [...text.matchAll(/PAGE MARKER (\d+)/g)].map((m) => m[1])
    ).size;
    rows.push([
      file.replace("--task-ocr.json", ""),
      String(saved.row.truePages),
      text.trim() ? "text" : "EMPTY",
      String(text.trim().length),
      saved.row.truePages > 1 ? `${markers}/${saved.row.truePages}` : "-",
      String(saved.row.completionTokens),
      `$${saved.row.costUsd.toFixed(4)}`,
    ]);
  }

  const head = ["variant", "pp", "result", "chars", "markers", "out-tok", "cost"];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});

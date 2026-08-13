#!/usr/bin/env tsx
/**
 * Generate a synthetic born-digital PDF so the bench can be smoke-tested
 * before the real corpus arrives.
 *
 *   tsx scripts/make-sample-pdf.ts test-corpus/00-synthetic.pdf 3
 *
 * The text is deterministic and painted (render mode 0), so this file is a
 * clean oracle: `readTruth` should report visible native text on every page,
 * and a working OCR pass should score near 100% fidelity against it. If the
 * bench reports anything odd on *this* file, the bug is ours, not the PDF's.
 *
 * Hand-rolled rather than pulling in a PDF writer — it is ~80 lines and the
 * bench should not need a dependency to self-test.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const WORDS = [
  "agreement", "witness", "declaration", "exhibit", "petitioner", "respondent",
  "county", "superior", "court", "filed", "notice", "hearing", "counsel",
  "affidavit", "service", "mandate", "record", "transcript", "order", "clerk",
];

function escapePdfText(s: string) {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

function pageLines(pageNumber: number): string[] {
  const lines = [`Synthetic Test Document - Page ${pageNumber + 1}`, ""];
  // Deterministic pseudo-prose: same file every run, so fidelity is comparable
  // across bench runs and a diff in the score means a real change.
  let seed = pageNumber * 7919 + 13;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let line = 0; line < 32; line++) {
    const words: string[] = [];
    for (let w = 0; w < 9; w++) words.push(WORDS[next() % WORDS.length]);
    lines.push(`${String(line + 1).padStart(2, "0")}  ${words.join(" ")}`);
  }
  return lines;
}

function contentStream(pageNumber: number): string {
  const parts = ["BT", "/F1 11 Tf", "72 720 Td", "13 TL"];
  for (const line of pageLines(pageNumber)) {
    parts.push(`(${escapePdfText(line)}) Tj`, "T*");
  }
  parts.push("ET");
  return parts.join("\n");
}

async function main() {
  const target = process.argv[2] ?? "test-corpus/00-synthetic.pdf";
  const pageCount = Number(process.argv[3] ?? 3);

  const objects: string[] = [];
  const add = (body: string) => objects.push(body);

  // 1 catalog, 2 pages tree, then per page: a page object + a content stream,
  // and finally the font. Object numbers are 1-based and assigned in order.
  const fontObj = 3 + pageCount * 2;
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`);

  add(`<< /Type /Catalog /Pages 2 0 R >>`);
  add(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`);
  for (let i = 0; i < pageCount; i++) {
    const contentsObj = 4 + i * 2;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentsObj} 0 R >>`
    );
    const stream = contentStream(i);
    add(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`
    );
  }
  add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(pdf, "latin1"));
  console.log(
    `Wrote ${target} — ${pageCount} pages, ${(Buffer.byteLength(pdf, "latin1") / 1024).toFixed(1)}KB`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

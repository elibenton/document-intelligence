/**
 * Heuristic-fire telemetry.
 *
 * `ocrToPages` in convex/interfaze.ts does not read pagination out of the OCR
 * result — it *infers* it, three different ways, and `coordinateScale` then
 * corrects axes it believes were rasterized at a multiple of page pixels.
 * Both are educated guesses that happen to work today.
 *
 * This module re-derives which branch a given precontext would take, read-only,
 * without touching production code. If the `sections-as-pages` branch or a
 * scale factor other than 1 shows up anywhere in the corpus, that is the
 * empirical argument for OCR'ing rendered page images instead of whole files.
 */

import type { Precontext } from "interfaze";

interface OcrPoint {
  x?: number;
  y?: number;
}
interface OcrBounds {
  top_left?: OcrPoint;
  top_right?: OcrPoint;
  bottom_right?: OcrPoint;
  bottom_left?: OcrPoint;
}
interface OcrWord {
  bounds?: OcrBounds;
}
interface OcrLine {
  bounds?: OcrBounds;
  words?: OcrWord[];
}
interface OcrSection {
  text?: string;
  lines?: OcrLine[];
}
interface OcrResult {
  sections?: OcrSection[];
  width?: number;
  height?: number;
  total_pages?: number;
}

export type PageBranch =
  | "none"
  | "per-result"
  | "sections-as-pages"
  | "single";

export interface Diagnosis {
  /** Which pagination branch `ocrToPages` would take. */
  branch: PageBranch;
  /** Number of `ocr` entries in precontext. */
  ocrEntries: number;
  /** `total_pages` as reported by the provider, if it reported one at all. */
  reportedTotalPages?: number;
  sectionCounts: number[];
  /** True when page height is being *divided*, not reported. */
  heightDivided: boolean;
  /** Distinct non-1 scale factors the coordinate correction would apply. */
  scaleFactors: number[];
  scaleFired: boolean;
  /** Every precontext entry name — reveals which specialists actually ran. */
  precontextNames: string[];
  /**
   * True when several `ocr` entries carry identical shape (same dimensions and
   * section counts) — i.e. the provider repeated one whole-document result
   * rather than emitting one per page. `ocrToPages` cannot tell the difference
   * and maps each duplicate onto a separate page.
   */
  duplicateOcrEntries: boolean;
  /** `per-result` is only safe when entry count equals the real page count. */
  entriesMatchPages: boolean;
}

function collectOcr(precontext: Precontext[]): OcrResult[] {
  return precontext
    .filter(
      (p) => p.name === "ocr" && typeof p.result === "object" && p.result !== null
    )
    .map((p) => p.result as OcrResult);
}

/** Mirrors `coordinateScale` in convex/interfaze.ts. */
function coordinateScale(maxCoordinate: number, pageDimension?: number) {
  if (!pageDimension || maxCoordinate <= pageDimension * 1.1) return 1;
  return 1 / Math.max(1, Math.ceil(maxCoordinate / pageDimension - 0.05));
}

function sectionMax(section: OcrSection) {
  let maxX = 0;
  let maxY = 0;
  const include = (bounds?: OcrBounds) => {
    for (const p of [
      bounds?.top_left,
      bounds?.top_right,
      bounds?.bottom_right,
      bounds?.bottom_left,
    ]) {
      if (typeof p?.x === "number") maxX = Math.max(maxX, p.x);
      if (typeof p?.y === "number") maxY = Math.max(maxY, p.y);
    }
  };
  for (const line of section.lines ?? []) {
    include(line.bounds);
    for (const word of line.words ?? []) include(word.bounds);
  }
  return { maxX, maxY };
}

export function diagnose(precontext: Precontext[]): Diagnosis {
  const names = precontext.map((p) => p.name);
  const ocrs = collectOcr(precontext);
  const base: Diagnosis = {
    branch: "none",
    ocrEntries: ocrs.length,
    sectionCounts: [],
    heightDivided: false,
    scaleFactors: [],
    scaleFired: false,
    precontextNames: names,
    duplicateOcrEntries: false,
    entriesMatchPages: true,
  };
  if (ocrs.length === 0) return base;

  const total = ocrs.find((o) => typeof o.total_pages === "number")?.total_pages;
  base.reportedTotalPages = total;
  base.sectionCounts = ocrs.map((o) => (o.sections ?? []).length);

  if (ocrs.length > 1) {
    // Must match production's fingerprint in convex/interfaze.ts, which is
    // content-aware. Shape alone false-positives on the per-page path, where
    // N same-sized page images legitimately yield N single-section results
    // that differ only in their text.
    const fingerprint = (o: OcrResult) => {
      const sections = o.sections ?? [];
      return [
        o.width,
        o.height,
        o.total_pages,
        sections.length,
        sections.map((s) => (s.text ?? "").length).join("."),
        (sections[0]?.text ?? "").slice(0, 120),
      ].join("|");
    };
    base.duplicateOcrEntries = new Set(ocrs.map(fingerprint)).size < ocrs.length;
    base.entriesMatchPages = total === undefined || ocrs.length === total;
  }

  const scales = new Set<number>();
  const noteScales = (
    sections: OcrSection[],
    width?: number,
    height?: number
  ) => {
    const extent = sections.reduce(
      (max, section) => {
        const current = sectionMax(section);
        return {
          maxX: Math.max(max.maxX, current.maxX),
          maxY: Math.max(max.maxY, current.maxY),
        };
      },
      { maxX: 0, maxY: 0 }
    );
    const sx = coordinateScale(extent.maxX, width);
    const sy = coordinateScale(extent.maxY, height);
    if (sx !== 1) scales.add(sx);
    if (sy !== 1) scales.add(sy);
  };

  if (ocrs.length > 1) {
    base.branch = "per-result";
    const entries = total && ocrs.length > total ? ocrs.slice(0, total) : ocrs;
    for (const o of entries) noteScales(o.sections ?? [], o.width, o.height);
  } else {
    const only = ocrs[0];
    const sections = only.sections ?? [];
    if (total && total > 1 && sections.length === total) {
      base.branch = "sections-as-pages";
      base.heightDivided = true;
      const pageHeight =
        typeof only.height === "number" ? only.height / total : undefined;
      for (const section of sections) {
        noteScales([section], only.width, pageHeight);
      }
    } else {
      base.branch = "single";
      noteScales(sections, only.width, only.height);
    }
  }

  base.scaleFactors = [...scales].sort((a, b) => a - b);
  base.scaleFired = base.scaleFactors.length > 0;
  return base;
}

/** One-line verdict for the console. Loudest problem first. */
export function verdict(d: Diagnosis): string {
  const flags: string[] = [];

  // The worst case, and not hypothetical: the provider repeats one
  // whole-document OCR result, `ocrToPages` reads the repeats as pages, and
  // every page after the first duplicate ends up empty or wrong.
  if (d.branch === "per-result" && d.duplicateOcrEntries) {
    flags.push(
      `BUG: ${d.ocrEntries} identical OCR entries treated as ${d.ocrEntries} pages`
    );
  } else if (d.branch === "per-result" && !d.entriesMatchPages) {
    flags.push(
      `entry count ${d.ocrEntries} != total_pages ${d.reportedTotalPages}`
    );
  }

  if (d.branch === "sections-as-pages") {
    flags.push("page height divided, not reported");
  }
  if (d.branch === "single" && (d.reportedTotalPages ?? 1) > 1) {
    flags.push("multi-page doc collapsed into one OCR page");
  }
  if (d.scaleFired) {
    flags.push(`coordinate scale fired: ${d.scaleFactors.join(", ")}`);
  }
  return flags.length ? flags.join("; ") : "clean";
}

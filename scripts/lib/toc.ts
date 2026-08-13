/**
 * Table-of-contents comparison — pure functions, no I/O, no API.
 *
 * The bench compares three ways of producing a TOC, and none of them is
 * ground truth: the current Analyze pass returned 5, 6, and 6 entries for three
 * runs over the *same* document. So this module deliberately separates two
 * different questions that look alike:
 *
 *   score()          how close is a candidate to a reference we trust
 *   selfAgreement()  how close is a method to itself across repeated runs
 *
 * A method that scores well on the first and badly on the second is not usable,
 * and averaging them would hide exactly that.
 */

export interface TocEntry {
  title: string;
  /** 1-based nesting depth, as stored on documents.tableOfContents. */
  level: number;
  /** 1-based page number, matching what the viewer navigates by. */
  page: number;
}

/**
 * Strip everything that varies between two renderings of the same heading:
 * case, punctuation, whitespace, and the leading section number, which one
 * method emits ("3.1 Scope") and another leaves in the body text ("Scope").
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^[\s([]*(?:\d+(?:[.\-–]\d+)*|[ivxlcdm]+|[a-z])[.):\-–—\s]+/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(title: string): string[] {
  const normalized = normalizeTitle(title);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Token F1 between two titles: 1 for identical wording, 0 for disjoint.
 *
 * Set-based rather than sequence-based on purpose — "Findings of Fact" and
 * "Fact Findings" are the same heading recovered in a different reading order,
 * which is a real difference between a layout-derived TOC and a text-derived
 * one, but not a difference worth calling a miss.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 1 : 0;
  const pool = new Map<string, number>();
  for (const token of right) pool.set(token, (pool.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of left) {
    const remaining = pool.get(token) ?? 0;
    if (remaining > 0) {
      shared++;
      pool.set(token, remaining - 1);
    }
  }
  if (shared === 0) return 0;
  const precision = shared / left.length;
  const recall = shared / right.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Below this, two titles are different headings rather than one recovered twice. */
export const MATCH_THRESHOLD = 0.6;

export interface Match {
  reference: TocEntry;
  candidate: TocEntry;
  similarity: number;
  /** candidate.page - reference.page. Signed: a method that drifts one way is worth seeing. */
  pageDelta: number;
}

export interface TocScore {
  referenceCount: number;
  candidateCount: number;
  matched: number;
  /** Share of reference entries the candidate found. */
  recall: number;
  /** Share of candidate entries that correspond to something real. */
  precision: number;
  f1: number;
  /** Of the matched entries, the share landing on the exact page / within one. */
  pageExact: number;
  pageWithin1: number;
  /** Of the matched entries, the share whose nesting depth agrees. */
  levelExact: number;
  medianAbsPageDelta: number;
  matches: Match[];
  missed: TocEntry[];
  spurious: TocEntry[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Greedy best-first matching. Every reference entry takes the best unclaimed
 * candidate above the threshold, strongest pairs first, so one good candidate
 * cannot be consumed by a weaker reference entry that happened to come earlier.
 */
export function score(reference: TocEntry[], candidate: TocEntry[]): TocScore {
  const pairs: Match[] = [];
  for (const ref of reference) {
    for (const cand of candidate) {
      const similarity = titleSimilarity(ref.title, cand.title);
      if (similarity >= MATCH_THRESHOLD) {
        pairs.push({
          reference: ref,
          candidate: cand,
          similarity,
          pageDelta: cand.page - ref.page,
        });
      }
    }
  }
  // Strongest first; ties broken by the smaller page jump, which is the more
  // plausible pairing when a heading legitimately repeats across sections.
  pairs.sort(
    (a, b) =>
      b.similarity - a.similarity || Math.abs(a.pageDelta) - Math.abs(b.pageDelta)
  );

  const usedReference = new Set<TocEntry>();
  const usedCandidate = new Set<TocEntry>();
  const matches: Match[] = [];
  for (const pair of pairs) {
    if (usedReference.has(pair.reference) || usedCandidate.has(pair.candidate)) continue;
    usedReference.add(pair.reference);
    usedCandidate.add(pair.candidate);
    matches.push(pair);
  }

  const matched = matches.length;
  const recall = reference.length ? matched / reference.length : 0;
  const precision = candidate.length ? matched / candidate.length : 0;
  const deltas = matches.map((m) => Math.abs(m.pageDelta));
  const share = (n: number) => (matched ? n / matched : 0);

  return {
    referenceCount: reference.length,
    candidateCount: candidate.length,
    matched,
    recall,
    precision,
    f1: recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0,
    pageExact: share(matches.filter((m) => m.pageDelta === 0).length),
    pageWithin1: share(matches.filter((m) => Math.abs(m.pageDelta) <= 1).length),
    levelExact: share(
      matches.filter((m) => m.reference.level === m.candidate.level).length
    ),
    medianAbsPageDelta: median(deltas),
    matches,
    missed: reference.filter((entry) => !usedReference.has(entry)),
    spurious: candidate.filter((entry) => !usedCandidate.has(entry)),
  };
}

/**
 * Mean pairwise F1 across repeated runs of one method on one document.
 *
 * 1.0 means the method returns the same TOC every time. Anything well below
 * that caps how much the accuracy numbers can be trusted — you cannot be
 * reliably right if you are not reliably anything.
 */
export function selfAgreement(runs: TocEntry[][]): number {
  if (runs.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      total += score(runs[i], runs[j]).f1;
      pairs++;
    }
  }
  return pairs ? total / pairs : 1;
}

// ---------------------------------------------------------------------------
// Heading detection from native PDF text geometry — the free arm.
// ---------------------------------------------------------------------------

export interface GeometryItem {
  text: string;
  /** Rendered glyph height in PDF units; pdf.js `transform[3]` for a text item. */
  size: number;
  /** 1-based. */
  page: number;
  /** Larger is earlier in reading order within a page. */
  order: number;
  bold?: boolean;
}

export interface HeadingOptions {
  /** How much larger than body text a line must be to read as a heading. */
  sizeRatio?: number;
  /** Longer than this and it is a sentence that happens to be big. */
  maxTitleChars?: number;
  /** Give up rather than emit noise when this share of lines look like headings. */
  maxHeadingShare?: number;
}

const DEFAULTS: Required<HeadingOptions> = {
  sizeRatio: 1.15,
  maxTitleChars: 120,
  maxHeadingShare: 0.25,
};

/** Past this, terminal punctuation means prose rather than a titled heading. */
const PROSE_MIN_CHARS = 60;

/**
 * Length alone cannot separate a heading from a large sentence: a pull quote
 * runs long, but so does "MEMORANDUM OF UNDERSTANDING BETWEEN THE CITY AND THE
 * COUNTY REGARDING SHARED SERVICES", which is exactly the heading we want. What
 * separates them is that prose closes a sentence and a heading does not — and
 * only once it is long enough for that to mean anything, so "Introduction." and
 * "3.1 Scope." stay headings.
 */
function looksLikeProse(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > PROSE_MIN_CHARS && /[.!?]$/.test(trimmed);
}

/**
 * Body text size = the size that the most *characters* are set in, not the most
 * lines. A document with many short big headings and few long body paragraphs
 * would otherwise elect its heading size as the body size and return nothing.
 */
export function bodyTextSize(items: GeometryItem[]): number {
  const weight = new Map<number, number>();
  for (const item of items) {
    const bucket = Math.round(item.size * 2) / 2;
    weight.set(bucket, (weight.get(bucket) ?? 0) + item.text.trim().length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, chars] of weight) {
    if (chars > bestWeight) {
      best = size;
      bestWeight = chars;
    }
  }
  return best;
}

/**
 * Headings from font size, with levels assigned by distinct size, largest
 * first. Deliberately conservative: this arm is free, so a miss costs nothing
 * and a false heading pollutes the Contents tab.
 *
 * Returns [] when the document has no size variation to work with (a scan's
 * OCR text, a single-font report) rather than guessing — that is a real answer
 * about which documents this arm can serve.
 */
export function headingsFromGeometry(
  items: GeometryItem[],
  options: HeadingOptions = {}
): TocEntry[] {
  const { sizeRatio, maxTitleChars, maxHeadingShare } = { ...DEFAULTS, ...options };
  const usable = items.filter((item) => item.text.trim().length > 0);
  if (usable.length === 0) return [];

  const body = bodyTextSize(usable);
  if (body <= 0) return [];

  const candidates = usable.filter(
    (item) =>
      (item.size >= body * sizeRatio || (item.bold === true && item.size > body)) &&
      item.text.trim().length <= maxTitleChars &&
      !looksLikeProse(item.text)
  );
  if (candidates.length === 0) return [];
  // Everything is a heading means nothing is.
  if (candidates.length / usable.length > maxHeadingShare) return [];

  const sizes = [...new Set(candidates.map((item) => Math.round(item.size * 2) / 2))].sort(
    (a, b) => b - a
  );
  const levelOf = new Map(sizes.map((size, index) => [size, index + 1]));

  return candidates
    .slice()
    .sort((a, b) => a.page - b.page || b.order - a.order)
    .map((item) => ({
      title: item.text.trim(),
      level: levelOf.get(Math.round(item.size * 2) / 2) ?? 1,
      page: item.page,
    }));
}

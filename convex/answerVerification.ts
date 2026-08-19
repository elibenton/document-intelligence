/**
 * Post-synthesis answer verification — the deterministic gate between what the
 * model wrote and what the user reads.
 *
 * The synthesis prompt orders the model to use only the provided sources, but
 * a prompt is a request, not a constraint: measured on a real search
 * (2026-08-19), the model produced a detailed ownership timeline from its own
 * world knowledge and stamped citations on pages containing none of it. So
 * every cited claim is checked here, after the fact, for token overlap against
 * the pages it cites — the same class of scoring the evidence-card highlighter
 * uses, no extra API call. Claims that fail are removed from the answer and
 * preserved for the UI to disclose.
 *
 * Pure module, no Convex imports, so vitest can run it directly
 * (see the OpenTelemetry note in vitest-cannot-import-convex-server).
 */

/**
 * The model's inline citation markers, in every shape stored answers actually
 * contain: `[5]`, `[5, 6]`, `[Source 5]`, `[Sources 1, 3]`,
 * `[Known Facts, Source 1]`. `(?!\()` keeps a real markdown link's
 * `[label](url)` out of it. Shared with the client renderer
 * (src/lib/citation/markers.ts) — one source of truth for what a marker is.
 */
export const CITATION_MARKER =
  /\[(?:known facts\s*,\s*)?(?:sources?\s+)?(\d+(?:\s*,\s*\d+)*)\](?!\()/gi;

/** Rewrite every marker shape to the canonical `[5][6]` form. */
export function normalizeCitationMarkers(answer: string): string {
  return answer.replace(CITATION_MARKER, (_match, digits: string) =>
    digits
      .split(",")
      .map((digit) => `[${Number(digit.trim())}]`)
      .join("")
  );
}

// Common words that carry no evidential weight; their presence in a source
// proves nothing. Deliberately generic — domain words stay significant.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "to", "is", "are",
  "was", "were", "be", "been", "being", "by", "for", "with", "as", "at",
  "from", "that", "this", "these", "those", "it", "its", "their", "they",
  "he", "she", "his", "her", "which", "who", "whom", "also", "has", "have",
  "had", "not", "no", "than", "then", "there", "here", "when", "while",
  "after", "before", "into", "over", "under", "between", "through", "during",
  "one", "two", "all", "any", "each", "both", "more", "most", "other", "some",
  "such", "only", "own", "same", "so", "can", "will", "just", "per", "held",
]);

function normalize(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s.]+/gu, " ")
    .replace(/\s+/g, " ");
}

/** Singular/plural shouldn't decide a claim's fate. */
function canonical(word: string): string {
  return word.replace(/\.+$/g, "").replace(/s$/, "");
}

function wordTokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .map(canonical)
    .filter((w) => w.length >= 3 && !/\d/.test(w) && !STOPWORDS.has(w));
}

/**
 * Every number in the text, decimal-preserving, comma-groups collapsed:
 * "22.5%" → "22.5", "$4,330" → "4330", "1958-1966" → "1958", "1966".
 * Numbers are the strongest hallucination signal — invented timelines are
 * made of dates and percentages the sources never state.
 */
function numberTokens(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) =>
    m[0].replace(/,/g, "").replace(/\.$/, "")
  );
}

/** Markdown syntax off, prose kept — so `**1966**:` verifies as "1966". */
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → label
    .replace(/[*_`~#>]+/g, " ")
    .replace(/^\s*(?:[-•]|\d+\.)\s+/, "");
}

export interface VerifiedAnswer {
  /** The answer with unsupported claims removed. */
  answer: string;
  /** How many cited claims were examined. */
  totalClaims: number;
  /** The claims (with their citations) that failed and were removed. */
  removedClaims: string[];
}

/** How much of a claim's distinctive vocabulary its cited pages must contain. */
const WORD_COVERAGE_FLOOR = 0.5;

/**
 * Check every cited claim in `answer` against the text of the sources it
 * cites (1-indexed into `sourceTexts`, the same order the synthesis prompt
 * numbered them) plus `groundTruth` (the entity-graph facts, which the prompt
 * also offered as citable ground). A claim survives only if all of its
 * numbers appear in that text and at least half of its distinctive words do.
 *
 * A claim is a run of text ending in citation markers; uncited text (headings,
 * connective prose) passes through untouched — the prompt's job is to make
 * sure facts don't hide there. Removal is by whole claim, and a line left
 * with no prose is dropped entirely, so a fabricated bullet vanishes instead
 * of leaving an empty "* :" behind.
 *
 * Markers that look like citations but resolve to no source — the model has
 * been observed inventing `[Web Search 2]` — count as citing nothing: their
 * claim must stand on real citations or the known facts, and the phantom
 * marker itself is stripped from the output either way. A markdown table row
 * that loses any claim is dropped whole, since removing one cell's text
 * leaves a mangled row.
 */
export function verifyAnswer(
  answer: string,
  sourceTexts: string[],
  groundTruth = ""
): VerifiedAnswer {
  const normalized = normalizeCitationMarkers(answer);
  // Per-source token sets, built lazily — most sources are cited once or twice.
  const wordSets = new Map<number, Set<string>>();
  const numberSets = new Map<number, Set<string>>();
  const truthWords = new Set(wordTokens(groundTruth));
  const truthNumbers = new Set(numberTokens(groundTruth));
  const sets = (n: number) => {
    if (!wordSets.has(n)) {
      const text = sourceTexts[n - 1] ?? "";
      wordSets.set(n, new Set(wordTokens(text)));
      numberSets.set(n, new Set(numberTokens(text)));
    }
    return { words: wordSets.get(n)!, numbers: numberSets.get(n)! };
  };

  let totalClaims = 0;
  const removedClaims: string[] = [];

  const lines = normalized.split("\n").map((line) => {
    // A citation run: adjacent bracket groups that contain a digit, none of
    // them a markdown link's label (the `(?!\()`). Canonical `[n]` groups are
    // real citations; anything else (`[Web Search 2]`) is a phantom — it
    // names no source, so it grounds nothing and is stripped.
    const runs = [
      ...line.matchAll(
        /\[[^\]\n]*\d[^\]\n]*\](?!\()(?:[ \t]*\[[^\]\n]*\d[^\]\n]*\](?!\())*/g
      ),
    ];
    if (runs.length === 0) return line;

    let rebuilt = "";
    let cursor = 0;
    let removedAny = false;
    for (const run of runs) {
      const claimText = line.slice(cursor, run.index);
      cursor = run.index + run[0].length;
      totalClaims += 1;

      const groups = run[0].match(/\[[^\]]*\]/g) ?? [];
      const cited = groups
        .filter((g) => /^\[\d+\]$/.test(g))
        .map((g) => Number(g.slice(1, -1)));
      const marker = cited.map((n) => `[${n}]`).join("");
      const prose = stripMarkdown(claimText);
      const words = wordTokens(prose);
      const numbers = numberTokens(prose);

      const hasWord = (w: string) =>
        truthWords.has(w) || cited.some((n) => sets(n).words.has(w));
      const hasNumber = (num: string) =>
        truthNumbers.has(num) || cited.some((n) => sets(n).numbers.has(num));

      const coverage =
        words.length === 0
          ? 1
          : words.filter(hasWord).length / words.length;
      const verified =
        numbers.every(hasNumber) && coverage >= WORD_COVERAGE_FLOOR;

      if (verified) {
        rebuilt += claimText + marker;
      } else {
        removedAny = true;
        removedClaims.push(`${claimText.trim()} ${run[0]}`.trim());
      }
    }
    rebuilt += line.slice(cursor);
    if (!removedAny) {
      // Phantom markers may still have been stripped from kept claims.
      return rebuilt;
    }
    // Removing one cell's claim from a table row leaves a mangled row; a row
    // that lost any claim goes whole.
    if (/^\s*\|/.test(line)) return null;
    // A removed leading claim can orphan the next sentence's punctuation.
    rebuilt = rebuilt.replace(/^(\s*)[.,;:]\s*/, "$1");
    // A line stripped of every claim is structure with nothing to say.
    return /\p{L}/u.test(stripMarkdown(rebuilt).replace(/\[\d+\]/g, ""))
      ? rebuilt
      : null;
  });

  // A heading whose entire section was removed has nothing to head. Sections
  // are flat here (the next heading of any level ends one), so a reverse walk
  // knows at each heading whether any prose survived below it.
  const kept = lines.filter((line): line is string => line !== null);
  const reversed: string[] = [];
  let contentBelow = false;
  for (let i = kept.length - 1; i >= 0; i--) {
    const line = kept[i];
    if (/^#{1,6}\s/.test(line.trim())) {
      if (contentBelow) reversed.push(line);
      contentBelow = false;
    } else {
      if (line.trim() !== "") contentBelow = true;
      reversed.push(line);
    }
  }

  const cleaned = reversed
    .reverse()
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { answer: cleaned, totalClaims, removedClaims };
}

/**
 * How a document is cut into the units that get embedded.
 *
 * Pure and free of Convex imports, like nameMatch.ts and speakerSignature.ts,
 * so chunking.test.ts can import it directly — the `_generated/server` chain
 * is what makes a Convex module untestable in vitest.
 *
 * WHY A CHUNK AND NOT A PAGE. A page used to be the embedding unit, which
 * broke at both ends. A recording is written as one page holding an entire
 * transcript, so an hour of interview became a single vector — the centroid
 * of everything it covers, near nothing in particular. And page text was
 * clipped to 8k characters before embedding, so a 100k-character web clip had
 * ~92% of itself silently absent from the semantic leg.
 *
 * WHY NOT SMALLER. The obvious fix — many tiny chunks — trades one failure for
 * another. A short span loses its referents ("he agreed to the transfer on the
 * 14th" is unfindable without the surrounding names), which bites hardest on
 * exactly the legal and government prose this corpus is full of. Overlap also
 * has a floor: below roughly 600-800 characters it either stops spanning a
 * sentence boundary or dominates cost. And the vector leg's fixed hit count
 * means finer chunks see proportionally less of the corpus per query.
 *
 * The precision people want from small chunks is really "this vector should be
 * about one specific thing", and `embeddingText` below buys that by ADDING
 * context rather than removing it.
 *
 * These numbers are a starting point to measure, not a derivation. Re-measure
 * against real queries before moving them.
 */

/** ~450 tokens: about the length of a passage a person would quote. */
export const PAGE_TARGET_CHARS = 1_800;
/** Enough to span a sentence, so a fact straddling a cut stays findable. */
export const PAGE_OVERLAP_CHARS = 200;
/** Never break earlier than this fraction of the target hunting for a seam. */
const MIN_BREAK_RATIO = 0.5;

/**
 * Audio goes finer than paper on purpose. A conversational turn is far more
 * self-contained than legal prose — a speaker re-establishes their subject
 * when they start talking — and diarized turns give a natural boundary paper
 * does not have. The payoff is larger too: seeking to the right thirty seconds
 * of an interview beats highlighting the right paragraph of a scan.
 */
export const TRANSCRIPT_TARGET_CHARS = 800;
export const TRANSCRIPT_TARGET_SECONDS = 30;

/** A slice of page text. `startChar`/`endChar` index the ORIGINAL string. */
export interface TextChunk {
  text: string;
  startChar: number;
  endChar: number;
}

/** Where a chunk may be cut, best seam first. */
const SEAMS: Array<{ pattern: string; after: number }> = [
  { pattern: "\n\n", after: 2 },
  { pattern: "\n", after: 1 },
  { pattern: ". ", after: 2 },
  { pattern: "? ", after: 2 },
  { pattern: "! ", after: 2 },
  { pattern: " ", after: 1 },
];

/**
 * The last index in [floor, ceiling) where `text` may be cut, preferring
 * paragraph over line over sentence over word. Returns -1 when the window
 * holds no seam at all, which is a single unbroken run — a base64 blob, a
 * CJK passage with no spaces — and is cut at the ceiling rather than grown
 * without bound.
 */
function findBreak(text: string, floor: number, ceiling: number): number {
  for (const { pattern, after } of SEAMS) {
    const at = text.lastIndexOf(pattern, ceiling - pattern.length);
    if (at >= floor) return at + after;
  }
  return -1;
}

/** Pull a [start, end) window in off surrounding whitespace, so the chunk
 *  reads clean AND still equals `text.slice(startChar, endChar)`. */
function tighten(text: string, start: number, end: number): TextChunk | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (s >= e) return null;
  return { text: text.slice(s, e), startChar: s, endChar: e };
}

export function chunkPageText(
  text: string,
  options: { targetChars?: number; overlapChars?: number } = {}
): TextChunk[] {
  const target = Math.max(1, options.targetChars ?? PAGE_TARGET_CHARS);
  const overlap = Math.max(0, Math.min(options.overlapChars ?? PAGE_OVERLAP_CHARS, target - 1));
  if (!text.trim()) return [];

  const chunks: TextChunk[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = cursor + target;
    if (end >= text.length) {
      end = text.length;
    } else {
      const floor = cursor + Math.floor(target * MIN_BREAK_RATIO);
      const seam = findBreak(text, floor, end);
      if (seam > cursor) end = seam;
    }

    const chunk = tighten(text, cursor, end);
    if (chunk) chunks.push(chunk);

    if (end >= text.length) break;
    // Strict progress is not optional: an overlap wider than the chunk just
    // produced would walk the cursor backwards and never terminate.
    const next = end - overlap;
    cursor = next > cursor ? next : end;
  }
  return chunks;
}

/** One diarized turn, as `transcriptSegments` stores it. */
export interface TranscriptSegmentInput {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

/** A window of whole turns. Anchored by time, never by character offset. */
export interface TranscriptChunk {
  text: string;
  startTime: number;
  endTime: number;
  /** Indices into the input array, for anchoring back to segment rows. */
  segmentStart: number;
  segmentEnd: number;
}

/**
 * Window whole segments up to a character or duration budget.
 *
 * A segment is never split. It carries the word-level timings the player seeks
 * by, so half a segment has no anchor a human can be sent to — and a turn is
 * the unit a person would quote anyway. A single segment longer than either
 * budget therefore becomes its own oversized chunk rather than being cut.
 *
 * Speaker labels ride inside the text: a window can span a question and its
 * answer, and "who said this" is most of what makes an interview passage mean
 * anything.
 */
export function chunkTranscriptSegments(
  segments: TranscriptSegmentInput[],
  options: { targetChars?: number; targetSeconds?: number } = {}
): TranscriptChunk[] {
  const targetChars = Math.max(1, options.targetChars ?? TRANSCRIPT_TARGET_CHARS);
  const targetSeconds = Math.max(1, options.targetSeconds ?? TRANSCRIPT_TARGET_SECONDS);

  const chunks: TranscriptChunk[] = [];
  let window: TranscriptSegmentInput[] = [];
  let windowStart = 0;
  let chars = 0;

  const flush = (endIndex: number) => {
    if (window.length === 0) return;
    const text = window
      .map((s) => `${s.speaker}: ${s.text.trim()}`)
      .join("\n")
      .trim();
    if (text) {
      chunks.push({
        text,
        startTime: window[0].start,
        endTime: window[window.length - 1].end,
        segmentStart: windowStart,
        segmentEnd: endIndex,
      });
    }
    window = [];
    chars = 0;
  };

  segments.forEach((segment, i) => {
    if (!segment.text.trim()) return;
    const spanSeconds = window.length
      ? segment.end - window[0].start
      : segment.end - segment.start;
    const wouldOverflow =
      window.length > 0 &&
      (chars + segment.text.length > targetChars || spanSeconds > targetSeconds);
    if (wouldOverflow) flush(i - 1);
    if (window.length === 0) windowStart = i;
    window.push(segment);
    chars += segment.text.length;
  });
  flush(segments.length - 1);

  return chunks;
}

/**
 * Rewrite leading diarizer labels to the names a human confirmed.
 *
 * `chunkTranscriptSegments` writes "Speaker 1: ..." because that is what the
 * diarizer produced and what `documentSpeakers` joins on. By embed time a
 * person may have said who Speaker 1 is, and "Charles Kessler said he signed
 * it" is a far better vector than "Speaker 1 said he signed it". Applied at
 * embed time, never stored, so naming a speaker improves the next embed
 * without rewriting a single chunk row.
 */
export function applySpeakerNames(
  text: string,
  names: ReadonlyMap<string, string>
): string {
  if (names.size === 0) return text;
  return text
    .split("\n")
    .map((line) => {
      const at = line.indexOf(": ");
      if (at === -1) return line;
      const named = names.get(line.slice(0, at));
      return named ? `${named}${line.slice(at)}` : line;
    })
    .join("\n");
}

/** What a chunk's document already knows about itself. */
export interface ChunkContext {
  title?: string | null;
  kind?: string | null;
  date?: string | null;
  place?: string | null;
  author?: string | null;
  /** Recordings only — the confirmed name, not the diarizer's "Speaker 1". */
  speaker?: string | null;
}

/**
 * The text actually sent to the embedding provider: a metadata header, then
 * the passage.
 *
 * This is the cheap half of contextual retrieval. The published version spends
 * an LLM call per chunk generating a context blurb, which for this corpus is
 * one call per chunk and exactly what the cost rules forbid; structured
 * metadata the pipeline already extracted gets most of the benefit for a few
 * dozen tokens and no calls at all.
 *
 * Never stored. Deriving it at embed time means a human correcting a title or
 * naming a speaker improves every subsequent embed with no schema change, and
 * the stored chunk text stays the raw passage a journalist reads.
 *
 * Field order is fixed so the same chunk produces the same bytes twice.
 */
export function embeddingText(context: ChunkContext, chunkText: string): string {
  const descriptors = [context.kind, context.date, context.place].filter(
    (v): v is string => Boolean(v?.trim())
  );
  const lines: string[] = [];
  const title = context.title?.trim();
  if (title) {
    lines.push(descriptors.length ? `${title} — ${descriptors.join(", ")}` : title);
  } else if (descriptors.length) {
    lines.push(descriptors.join(", "));
  }
  if (context.author?.trim()) lines.push(`Author: ${context.author.trim()}`);
  if (context.speaker?.trim()) lines.push(`Speaker: ${context.speaker.trim()}`);
  return lines.length ? `${lines.join("\n")}\n\n${chunkText}` : chunkText;
}

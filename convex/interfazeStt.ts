/**
 * `speech_to_text` task payload -> stored transcript segments.
 *
 * Pure data transforms over the shape Interfaze returns: no SDK calls, no
 * network, no node built-ins. Kept apart from the client for the same reason
 * interfazeOcr.ts is — the grouping and label rules are the only place
 * transcript structure is decided, and they are worth unit-testing on their own.
 */

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
}

/**
 * The task payload. One chunk per word, each carrying its own speaker — the
 * diarization and the word timing arrive together, which is why segments are
 * grouped here rather than asked for.
 */
export interface SttChunk {
  timestamp?: (number | null)[];
  text?: string;
  speaker?: string;
}

export interface SttTaskResult {
  text?: string;
  chunks?: SttChunk[];
}

/**
 * Normalize an STT speaker label to "Speaker N".
 *
 * STT backends emit 0-based labels ("speaker_0", "SPEAKER_00"), so every numeric
 * label is shifted by one — uniformly. Shifting only index 0 would collapse
 * speaker_0 and speaker_1 onto "Speaker 1", silently merging two people.
 */
export function normalizeSpeaker(
  s: string | number | undefined,
  i: number
): string {
  if (typeof s === "number") return `Speaker ${s + 1}`;
  if (typeof s === "string" && s.trim()) {
    const m = s.match(/^speaker[_\s-]?(\d+)$/i);
    return m ? `Speaker ${Number(m[1]) + 1}` : s;
  }
  return `Speaker ${i + 1}`;
}

/**
 * Group per-word chunks into speaker turns.
 *
 * A new segment starts whenever the speaker changes, which is the same rule the
 * old structured-output schema asked the model to follow — the difference is
 * that the boundary is now read off the diarizer rather than re-derived. Raw
 * labels are mapped once, so a label the provider repeats maps to a stable
 * "Speaker N", and an unlabeled stream collapses to one speaker rather than one
 * speaker per word.
 */
export function chunksToSegments(chunks: SttChunk[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const labelByRaw = new Map<string, string>();
  let current: TranscriptSegment | undefined;

  for (const chunk of chunks) {
    const word = (chunk.text ?? "").trim();
    if (!word) continue;

    // A chunk whose timestamps are missing or null still carries a word; it
    // just cannot be seeked to. Inheriting the previous end keeps the sequence
    // monotonic, which is what click-to-seek and the active-word scan assume.
    const prevEnd = current?.end ?? 0;
    const rawStart = chunk.timestamp?.[0];
    const rawEnd = chunk.timestamp?.[1];
    const start = typeof rawStart === "number" ? rawStart : prevEnd;
    const end = typeof rawEnd === "number" ? rawEnd : start;

    const raw = chunk.speaker ?? "";
    let label = labelByRaw.get(raw);
    if (label === undefined) {
      label = normalizeSpeaker(raw, labelByRaw.size);
      labelByRaw.set(raw, label);
    }

    if (!current || current.speaker !== label) {
      current = { speaker: label, start, end, text: "", words: [] };
      segments.push(current);
    }
    current.words.push({ word, start, end });
    current.end = Math.max(current.end, end);
  }

  for (const segment of segments) {
    segment.text = segment.words.map((w) => w.word).join(" ");
  }
  return segments;
}

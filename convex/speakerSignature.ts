// Pure and import-free so the browser and the confirm mutation compute the
// same value from the same segments — the interfazeLimits.ts pattern.

/**
 * A cheap fingerprint of a transcript's diarization:
 * "distinctLabelCount:segmentCount". The naming dialog compares it against
 * documents.speakerNamingSignature to decide whether the human has answered
 * the naming question for *this* transcript — a re-transcription that
 * changes either count flips the comparison and forces a re-confirm rather
 * than a silent re-application of old names.
 */
export function transcriptSignature(
  segments: readonly { speaker: string }[]
): string {
  const labels = new Set<string>();
  for (const seg of segments) labels.add(seg.speaker);
  return `${labels.size}:${segments.length}`;
}

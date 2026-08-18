// Deterministic per-speaker accent colors, keyed on the raw diarizer label
// ("Speaker 1") in first-appearance order — which keeps a speaker's color
// stable through renames, since a display name never becomes the key.
// Shared by the transcript and the speaker-naming dialog.
export const SPEAKER_COLORS = [
  "text-blue-600 dark:text-blue-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-purple-600 dark:text-purple-400",
  "text-rose-600 dark:text-rose-400",
  "text-amber-600 dark:text-amber-400",
  "text-cyan-600 dark:text-cyan-400",
];

export function buildSpeakerColorMap(
  segments: readonly { speaker: string }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const seg of segments) {
    if (!map.has(seg.speaker)) {
      map.set(seg.speaker, SPEAKER_COLORS[map.size % SPEAKER_COLORS.length]);
    }
  }
  return map;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = h > 0 ? String(m % 60).padStart(2, "0") : String(m);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

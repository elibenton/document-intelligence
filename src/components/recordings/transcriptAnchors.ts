// Pure playhead→transcript resolution. The old implementation scanned every
// word of every segment per timeupdate tick; these two binary searches make
// the per-tick cost O(log n) so a one-hour recording stays cheap.

export interface AnchorSegment {
  startTime: number;
  endTime: number;
  words: { start: number }[];
}

export interface ActivePosition {
  segment: number;
  word: number;
}

/** Index of the last element whose key is <= time, or -1. */
function lastAtOrBefore(length: number, keyAt: (i: number) => number, time: number): number {
  let lo = 0;
  let hi = length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keyAt(mid) <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The segment and word under the playhead.
 *
 * A segment claims [startTime, max(endTime, next segment's start)) — the same
 * gap-tolerant rule the linear scan used, so silence between turns still
 * highlights the turn just spoken rather than nothing.
 */
export function findActive(
  segments: readonly AnchorSegment[],
  time: number,
): ActivePosition {
  const si = lastAtOrBefore(segments.length, (i) => segments[i].startTime, time);
  if (si < 0) return { segment: -1, word: -1 };
  const seg = segments[si];
  const claimEnd = Math.max(seg.endTime, segments[si + 1]?.startTime ?? Infinity);
  if (time >= claimEnd) return { segment: -1, word: -1 };
  const wi = lastAtOrBefore(seg.words.length, (i) => seg.words[i].start, time);
  return { segment: si, word: wi };
}

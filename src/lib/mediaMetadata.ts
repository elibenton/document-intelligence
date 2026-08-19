/**
 * Source-native facts read off a media or image file at upload time, in the
 * browser — the file is already in hand, so no storage round-trip or server
 * work is spent. The server re-sanitizes everything (upload.createDocument),
 * the same trust model as the client-computed contentHash.
 *
 * Deliberately date-only for recordings: a container's title/artist tags are
 * not taken (that naming belongs to analysis or the user), and
 * `file.lastModified` is never used — it usually records the download, not
 * the recording.
 */

import { mp4CreationDate, wavBextOriginationDate } from "../../convex/mediaDates";
import { exifCreatedDate } from "../../convex/exifDate";
import { exifStringToIso } from "../../convex/nativeDate";

export function isVideoUpload(file: File): boolean {
  return file.type.toLowerCase().startsWith("video/");
}

export function isImageUpload(file: File): boolean {
  return file.type.toLowerCase().startsWith("image/");
}

/** Enough of the head to cover a front-loaded moov or a WAV's bext chunk. */
const HEAD_SLICE_BYTES = 1_500_000;

/**
 * The date the recording container says it was made, as an ISO string, or
 * null. mediabunny's normalized tag reader first (ID3, MP4 ilst, RIFF INFO,
 * Vorbis, FLAC); the mvhd/bext leaf parsers cover what it doesn't surface.
 */
export async function readMediaCreatedDate(file: File): Promise<string | null> {
  try {
    const tagged = await readTaggedDate(file);
    if (tagged) return tagged;
  } catch {
    // Tag reading is best-effort; the leaf parsers still get their turn.
  }
  try {
    const head = new Uint8Array(
      await file.slice(0, HEAD_SLICE_BYTES).arrayBuffer()
    );
    return mp4CreationDate(head) ?? wavBextOriginationDate(head);
  } catch {
    return null;
  }
}

async function readTaggedDate(file: File): Promise<string | null> {
  const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny");
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    if (!(await input.canRead())) return null;
    const tags = await input.getMetadataTags();
    if (!(tags.date instanceof Date) || Number.isNaN(tags.date.getTime())) {
      return null;
    }
    return tags.date.toISOString().slice(0, 10);
  } finally {
    input.dispose();
  }
}

/** The date a photo's EXIF block says it was taken, as ISO, or null. */
export async function readImageCreatedDate(file: File): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return exifStringToIso(exifCreatedDate(bytes));
  } catch {
    return null;
  }
}

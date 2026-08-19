/**
 * Recording dates the mediabunny tag reader does not surface: the MP4 movie
 * header's creation time and a WAV's broadcast-extension origination date.
 * Callers try mediabunny's normalized tags first; these are the fallbacks.
 *
 * Pure bytes-in string-out, no Convex imports — shared verbatim by the
 * browser upload path and the backfill action, pinned by vitest. Head-slice
 * based: an MP4 whose moov trails the media data yields null here, which is
 * fine because mediabunny already ran.
 *
 * Returns ISO strings; callers finish with sanitizeNativeDate.
 */

/** MP4/QuickTime epoch (1904-01-01 UTC) to Unix epoch, in seconds. */
const MP4_EPOCH_OFFSET_SECONDS = 2082844800;

/**
 * Encoders routinely write 0 or their own build date into mvhd's creation
 * time; anything before consumer digital recording existed is that garbage,
 * not a recording date.
 */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);

/** The mvhd creation time of an MP4-family file, or nothing. */
export function mp4CreationDate(bytes: Uint8Array): string | null {
  try {
    const moov = findBox(bytes, 0, bytes.length, "moov");
    if (!moov) return null;
    const mvhd = findBox(bytes, moov.start, moov.end, "mvhd");
    if (!mvhd) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (mvhd.start + 4 > mvhd.end) return null;
    const version = view.getUint8(mvhd.start);
    let seconds: number;
    if (version === 1) {
      if (mvhd.start + 12 > mvhd.end) return null;
      seconds = Number(view.getBigUint64(mvhd.start + 4, false));
    } else {
      if (mvhd.start + 8 > mvhd.end) return null;
      seconds = view.getUint32(mvhd.start + 4, false);
    }
    if (seconds === 0) return null;
    const ms = (seconds - MP4_EPOCH_OFFSET_SECONDS) * 1000;
    if (!Number.isFinite(ms) || ms < EARLIEST_PLAUSIBLE_MS) return null;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** Walk sibling boxes in [from, to) for one of the given type. */
function findBox(
  bytes: Uint8Array,
  from: number,
  to: number,
  type: string
): { start: number; end: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = from;
  while (offset + 8 <= to) {
    let size = view.getUint32(offset, false);
    const name = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) return null;
      size = Number(view.getBigUint64(offset + 8, false));
      header = 16;
    } else if (size === 0) {
      size = to - offset; // extends to end
    }
    if (size < header) return null;
    if (name === type) {
      return { start: offset + header, end: Math.min(offset + size, to) };
    }
    offset += size;
  }
  return null;
}

/**
 * A WAV's stated origination date, or nothing: the bext (Broadcast Wave)
 * OriginationDate first, then the RIFF INFO ICRD entry.
 */
export function wavBextOriginationDate(bytes: Uint8Array): string | null {
  try {
    if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    let icrd: string | null = null;
    while (offset + 8 <= bytes.length) {
      const id = ascii(bytes, offset, 4);
      const size = view.getUint32(offset + 4, true);
      const data = offset + 8;
      const end = data + size;
      if (end > bytes.length) break;
      if (id === "bext" && size >= 330) {
        // OriginationDate: 10 ASCII bytes at offset 320, "YYYY-MM-DD" with
        // the spec allowing any separator.
        const raw = ascii(bytes, data + 320, 10).replace(/[:/_.]/g, "-");
        const normalized = normalizeIsoDay(raw);
        if (normalized) return normalized;
      }
      if (id === "LIST" && ascii(bytes, data, 4) === "INFO") {
        icrd = icrd ?? readInfoIcrd(bytes, data + 4, end);
      }
      offset = end + (size % 2); // chunks are word-aligned
    }
    return icrd;
  } catch {
    return null;
  }
}

/** The ICRD (creation date) entry of a RIFF INFO list, or nothing. */
function readInfoIcrd(bytes: Uint8Array, from: number, to: number): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = from;
  while (offset + 8 <= to) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (data + size > to) return null;
    if (id === "ICRD") {
      const raw = ascii(bytes, data, size)
        .replace(/\0.*$/, "")
        .trim()
        .replace(/[:/_.]/g, "-");
      // ICRD is free text in practice; keep a date-shaped prefix only.
      const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(raw);
      if (!match) return null;
      const [, year, month, day] = match;
      if (day) return normalizeIsoDay(`${year}-${month}-${day}`);
      return month ? `${year}-${month}` : year;
    }
    offset = data + size + (size % 2);
  }
  return null;
}

function normalizeIsoDay(raw: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

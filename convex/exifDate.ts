/**
 * The date a camera stamped into an image, or nothing.
 *
 * One TIFF-IFD walker behind container entry points for the image types
 * detectMediaType accepts (JPEG, PNG, WebP, TIFF; GIF has no EXIF). Pure
 * bytes-in string-out, no Convex imports, so upload preflight in the browser
 * and the backfill action run identical code. Deliberately hand-rolled over a
 * dependency: one tag family across four containers is bounded, and a library
 * with environment-detection shims is the riskier line count.
 *
 * Returns the raw EXIF string ("2019:03:14 10:22:01"); callers compose
 * exifStringToIso + sanitizeNativeDate from nativeDate.ts.
 */

const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003; // when the shutter fired
const TAG_CREATE_DATE = 0x9004; // when the file was written
const TAG_DATE_TIME = 0x0132; // IFD0 catch-all, last resort

/** The created date stated by the image's EXIF block, or null. */
export function exifCreatedDate(bytes: Uint8Array): string | null {
  try {
    const tiff = findTiffPayload(bytes);
    if (!tiff) return null;
    return readTiffDate(tiff);
  } catch {
    // A truncated or malicious file must degrade to "no date", never throw.
    return null;
  }
}

/** Locate the TIFF-structured EXIF payload inside the container. */
function findTiffPayload(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12) return null;
  // Bare TIFF: the file is the payload.
  if (isTiffHeader(bytes, 0)) return bytes;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegExifPayload(bytes);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return pngExifPayload(bytes);
  if (
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return webpExifPayload(bytes);
  }
  return null;
}

function isTiffHeader(bytes: Uint8Array, offset: number): boolean {
  const order = ascii(bytes, offset, 2);
  if (order !== "II" && order !== "MM") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(offset + 2, order === "II") === 42;
}

/** Walk JPEG APP markers to APP1 "Exif\0\0". */
function jpegExifPayload(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // Start-of-scan or end: no more metadata segments follow.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = view.getUint16(offset + 2, false);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (marker === 0xe1 && ascii(bytes, offset + 4, 6) === "Exif\0\0") {
      return bytes.subarray(offset + 10, offset + 2 + length);
    }
    offset += 2 + length;
  }
  return null;
}

/** Walk PNG chunks to eXIf. */
function pngExifPayload(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8; // signature
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    if (offset + 8 + length > bytes.length) return null;
    if (type === "eXIf") return bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT" || type === "IEND") return null;
    offset += 8 + length + 4; // + CRC
  }
  return null;
}

/** Walk WebP RIFF chunks to EXIF. */
function webpExifPayload(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12; // RIFF size WEBP
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    if (offset + 8 + length > bytes.length) return null;
    if (type === "EXIF") {
      let payload = bytes.subarray(offset + 8, offset + 8 + length);
      // Some writers include the JPEG-style "Exif\0\0" prefix; the spec omits it.
      if (ascii(payload, 0, 6) === "Exif\0\0") payload = payload.subarray(6);
      return payload;
    }
    offset += 8 + length + (length % 2); // chunks are word-aligned
  }
  return null;
}

/** DateTimeOriginal → CreateDate → IFD0 DateTime, first hit wins. */
function readTiffDate(tiff: Uint8Array): string | null {
  if (!isTiffHeader(tiff, 0)) return null;
  const little = ascii(tiff, 0, 2) === "II";
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd0 = view.getUint32(4, little);

  const readAsciiTag = (
    ifdOffset: number,
    wanted: number
  ): string | null => {
    if (ifdOffset + 2 > tiff.length) return null;
    const count = view.getUint16(ifdOffset, little);
    for (let i = 0; i < count; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > tiff.length) return null;
      if (view.getUint16(entry, little) !== wanted) continue;
      const type = view.getUint16(entry + 2, little);
      if (type !== 2) return null; // ASCII
      const length = view.getUint32(entry + 4, little);
      const at = length <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
      if (at + length > tiff.length) return null;
      // Trailing NUL included in the count.
      return ascii(tiff, at, Math.max(0, length - 1));
    }
    return null;
  };

  const readPointer = (ifdOffset: number, wanted: number): number | null => {
    if (ifdOffset + 2 > tiff.length) return null;
    const count = view.getUint16(ifdOffset, little);
    for (let i = 0; i < count; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > tiff.length) return null;
      if (view.getUint16(entry, little) === wanted) {
        return view.getUint32(entry + 8, little);
      }
    }
    return null;
  };

  const exifIfd = readPointer(ifd0, TAG_EXIF_IFD_POINTER);
  if (exifIfd !== null) {
    const original = readAsciiTag(exifIfd, TAG_DATE_TIME_ORIGINAL);
    if (original) return original;
    const created = readAsciiTag(exifIfd, TAG_CREATE_DATE);
    if (created) return created;
  }
  return readAsciiTag(ifd0, TAG_DATE_TIME);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

import { describe, expect, it } from "vitest";
import { exifCreatedDate } from "./exifDate";

// ---------------------------------------------------------------------------
// Hand-built minimal containers. The TIFF builder writes one IFD0 that may
// point at an Exif sub-IFD, with ASCII values in a data area after the IFDs.
// ---------------------------------------------------------------------------

type TagSpec = { tag: number; value: string } | { tag: number; pointer: true };

function buildTiff(
  little: boolean,
  ifd0Tags: TagSpec[],
  exifTags: Array<{ tag: number; value: string }> = []
): Uint8Array {
  const buffer = new ArrayBuffer(1024);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const u16 = (at: number, v: number) => view.setUint16(at, v, little);
  const u32 = (at: number, v: number) => view.setUint32(at, v, little);

  bytes[0] = bytes[1] = little ? 0x49 : 0x4d; // II / MM
  u16(2, 42);
  u32(4, 8); // IFD0 at 8

  const ifd0Start = 8;
  const ifd0Size = 2 + ifd0Tags.length * 12 + 4;
  const exifStart = ifd0Start + ifd0Size;
  const exifSize = exifTags.length ? 2 + exifTags.length * 12 + 4 : 0;
  let dataAt = exifStart + exifSize;

  const writeAscii = (entry: number, tag: number, value: string) => {
    const withNul = value + "\0";
    u16(entry, tag);
    u16(entry + 2, 2); // ASCII
    u32(entry + 4, withNul.length);
    if (withNul.length <= 4) {
      for (let i = 0; i < withNul.length; i++) {
        bytes[entry + 8 + i] = withNul.charCodeAt(i);
      }
    } else {
      u32(entry + 8, dataAt);
      for (let i = 0; i < withNul.length; i++) {
        bytes[dataAt + i] = withNul.charCodeAt(i);
      }
      dataAt += withNul.length;
    }
  };

  u16(ifd0Start, ifd0Tags.length);
  ifd0Tags.forEach((spec, i) => {
    const entry = ifd0Start + 2 + i * 12;
    if ("pointer" in spec) {
      u16(entry, spec.tag);
      u16(entry + 2, 4); // LONG
      u32(entry + 4, 1);
      u32(entry + 8, exifStart);
    } else {
      writeAscii(entry, spec.tag, spec.value);
    }
  });

  if (exifTags.length) {
    u16(exifStart, exifTags.length);
    exifTags.forEach((spec, i) => {
      writeAscii(exifStart + 2 + i * 12, spec.tag, spec.value);
    });
  }

  return bytes.subarray(0, dataAt);
}

function jpegWrap(tiff: Uint8Array): Uint8Array {
  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
  payload.set(tiff, 6);
  const out = new Uint8Array(4 + 4 + payload.length + 2);
  out.set([0xff, 0xd8, 0xff, 0xe1]);
  new DataView(out.buffer).setUint16(4, payload.length + 2, false);
  out.set(payload, 6);
  out.set([0xff, 0xd9], 6 + payload.length);
  return out;
}

function pngWrap(tiff: Uint8Array): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(8 + 8 + tiff.length + 4 + 12);
  out.set(signature);
  const view = new DataView(out.buffer);
  view.setUint32(8, tiff.length, false);
  out.set([0x65, 0x58, 0x49, 0x66], 12); // "eXIf"
  out.set(tiff, 16);
  // trailing IEND (length 0)
  const at = 16 + tiff.length + 4;
  view.setUint32(at, 0, false);
  out.set([0x49, 0x45, 0x4e, 0x44], at + 4);
  return out;
}

function webpWrap(tiff: Uint8Array, withPrefix = false): Uint8Array {
  const payload = withPrefix
    ? (() => {
        const p = new Uint8Array(6 + tiff.length);
        p.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
        p.set(tiff, 6);
        return p;
      })()
    : tiff;
  const out = new Uint8Array(12 + 8 + payload.length + (payload.length % 2));
  out.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  out.set([0x45, 0x58, 0x49, 0x46], 12); // EXIF
  new DataView(out.buffer).setUint32(16, payload.length, true);
  out.set(payload, 20);
  return out;
}

const DATE = "2019:03:14 10:22:01";

describe("exifCreatedDate", () => {
  it("reads DateTimeOriginal from a little-endian JPEG APP1", () => {
    const tiff = buildTiff(true, [{ tag: 0x8769, pointer: true }], [
      { tag: 0x9003, value: DATE },
    ]);
    expect(exifCreatedDate(jpegWrap(tiff))).toBe(DATE);
  });

  it("reads big-endian TIFF payloads", () => {
    const tiff = buildTiff(false, [{ tag: 0x8769, pointer: true }], [
      { tag: 0x9003, value: DATE },
    ]);
    expect(exifCreatedDate(jpegWrap(tiff))).toBe(DATE);
  });

  it("falls back DateTimeOriginal → CreateDate → IFD0 DateTime", () => {
    const createOnly = buildTiff(true, [{ tag: 0x8769, pointer: true }], [
      { tag: 0x9004, value: "2020:01:02 03:04:05" },
    ]);
    expect(exifCreatedDate(jpegWrap(createOnly))).toBe("2020:01:02 03:04:05");

    const ifd0Only = buildTiff(true, [{ tag: 0x0132, value: DATE }]);
    expect(exifCreatedDate(jpegWrap(ifd0Only))).toBe(DATE);
  });

  it("reads a bare TIFF file", () => {
    const tiff = buildTiff(true, [{ tag: 0x0132, value: DATE }]);
    expect(exifCreatedDate(tiff)).toBe(DATE);
  });

  it("reads PNG eXIf and WebP EXIF chunks", () => {
    const tiff = buildTiff(true, [{ tag: 0x0132, value: DATE }]);
    expect(exifCreatedDate(pngWrap(tiff))).toBe(DATE);
    expect(exifCreatedDate(webpWrap(tiff))).toBe(DATE);
    expect(exifCreatedDate(webpWrap(tiff, true))).toBe(DATE);
  });

  it("returns null, never throws, on truncated or dateless input", () => {
    const tiff = buildTiff(true, [{ tag: 0x8769, pointer: true }], [
      { tag: 0x9003, value: DATE },
    ]);
    const jpeg = jpegWrap(tiff);
    for (let cut = 0; cut < jpeg.length; cut += 7) {
      expect(() => exifCreatedDate(jpeg.subarray(0, cut))).not.toThrow();
    }
    expect(exifCreatedDate(new Uint8Array(0))).toBeNull();
    expect(exifCreatedDate(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF
    expect(
      exifCreatedDate(jpegWrap(buildTiff(true, [{ tag: 0x0110, value: "cam" }])))
    ).toBeNull();
  });
});

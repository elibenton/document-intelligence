import { describe, expect, it } from "vitest";
import { mp4CreationDate, wavBextOriginationDate } from "./mediaDates";

const MP4_EPOCH_OFFSET = 2082844800;

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function mvhd(version: 0 | 1, creationSeconds: number): Uint8Array {
  const body = new Uint8Array(version === 1 ? 28 : 20);
  const view = new DataView(body.buffer);
  view.setUint8(0, version);
  if (version === 1) {
    view.setBigUint64(4, BigInt(creationSeconds), false);
  } else {
    view.setUint32(4, creationSeconds, false);
  }
  return body;
}

function mp4(version: 0 | 1, creationSeconds: number): Uint8Array {
  const ftyp = box("ftyp", new Uint8Array(8));
  const moov = box("moov", box("mvhd", mvhd(version, creationSeconds)));
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp);
  out.set(moov, ftyp.length);
  return out;
}

describe("mp4CreationDate", () => {
  const seconds = MP4_EPOCH_OFFSET + Math.floor(Date.UTC(2023, 5, 10) / 1000);

  it("reads version 0 and version 1 movie headers", () => {
    expect(mp4CreationDate(mp4(0, seconds))).toBe("2023-06-10");
    expect(mp4CreationDate(mp4(1, seconds))).toBe("2023-06-10");
  });

  it("rejects zero and pre-1990 encoder garbage", () => {
    expect(mp4CreationDate(mp4(0, 0))).toBeNull();
    expect(mp4CreationDate(mp4(0, 12345))).toBeNull(); // 1904-ish
    expect(
      mp4CreationDate(mp4(0, MP4_EPOCH_OFFSET + Math.floor(Date.UTC(1985, 0, 1) / 1000)))
    ).toBeNull();
  });

  it("returns null when moov trails beyond the slice", () => {
    const whole = mp4(0, seconds);
    expect(mp4CreationDate(whole.subarray(0, 20))).toBeNull();
    expect(mp4CreationDate(new Uint8Array(0))).toBeNull();
  });
});

function riffChunk(id: string, body: Uint8Array): Uint8Array {
  const padded = body.length % 2 ? body.length + 1 : body.length;
  const out = new Uint8Array(8 + padded);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function wav(...chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 4);
  const out = new Uint8Array(8 + size);
  out.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  new DataView(out.buffer).setUint32(4, size, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  let at = 12;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function bext(date: string): Uint8Array {
  const body = new Uint8Array(602); // spec-minimum bext size
  for (let i = 0; i < date.length; i++) body[320 + i] = date.charCodeAt(i);
  return riffChunk("bext", body);
}

function infoIcrd(text: string): Uint8Array {
  const inner = new Uint8Array(4 + 8 + text.length + (text.length % 2));
  inner.set([0x49, 0x4e, 0x46, 0x4f]); // INFO
  inner.set([0x49, 0x43, 0x52, 0x44], 4); // ICRD
  new DataView(inner.buffer).setUint32(8, text.length, true);
  for (let i = 0; i < text.length; i++) inner[12 + i] = text.charCodeAt(i);
  return riffChunk("LIST", inner);
}

describe("wavBextOriginationDate", () => {
  it("reads the bext OriginationDate, normalizing separators", () => {
    expect(wavBextOriginationDate(wav(bext("2022-11-03")))).toBe("2022-11-03");
    expect(wavBextOriginationDate(wav(bext("2022:11:03")))).toBe("2022-11-03");
  });

  it("falls back to LIST/INFO ICRD, keeping its stated precision", () => {
    expect(wavBextOriginationDate(wav(infoIcrd("2021-07-15\0")))).toBe(
      "2021-07-15"
    );
    expect(wavBextOriginationDate(wav(infoIcrd("2021")))).toBe("2021");
  });

  it("prefers bext over ICRD", () => {
    expect(
      wavBextOriginationDate(wav(infoIcrd("2020-01-01"), bext("2022-11-03")))
    ).toBe("2022-11-03");
  });

  it("returns null on malformed RIFF, never throws", () => {
    expect(wavBextOriginationDate(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(wavBextOriginationDate(wav(bext("not a date")))).toBeNull();
    const truncated = wav(bext("2022-11-03")).subarray(0, 40);
    expect(() => wavBextOriginationDate(truncated)).not.toThrow();
  });
});

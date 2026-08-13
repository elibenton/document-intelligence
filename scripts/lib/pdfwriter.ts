/**
 * A deliberately awkward PDF writer.
 *
 * The edge-case corpus needs files that are *legal but unusual* — xref streams,
 * incremental updates, rotated pages, exotic colour spaces, RC4 encryption,
 * broken xref offsets. No PDF library on this machine emits those on demand
 * (qpdf, Ghostscript and the Python stack are all absent), and poppler only
 * reads. So the corpus is written here, byte by byte.
 *
 * Correctness matters more than usual: if the writer is subtly wrong, every
 * variant fails for the writer's reason rather than its own, and the whole
 * matrix reads as "everything breaks". Every document this module emits is
 * therefore re-opened with pdf.js before it is used (see `make-variants.ts`),
 * and the corpus includes a positive control built the same way.
 */

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

export interface Ref {
  num: number;
  toString(): string;
}

const ref = (num: number): Ref => ({
  num,
  toString: () => `${num} 0 R`,
});

/** Object bodies are latin1 text; stream payloads stay binary. */
interface PdfObject {
  num: number;
  dict: string;
  stream?: Buffer;
  /** Placed in an object stream instead of at top level (PDF 1.5+). */
  compressed?: boolean;
}

export interface BuildOptions {
  version?: string;
  /** "table" is the classic xref; "stream" is PDF 1.5 xref streams + ObjStm. */
  xref?: "table" | "stream";
  /**
   * Corrupt every xref entry offset. Readers that trust the table fail; readers
   * that rebuild by scanning for "N 0 obj" recover. Real files get this way when
   * a document is edited by a tool that miscomputes offsets.
   */
  corruptXref?: boolean;
  /** Omit the high-bit comment on line 2 that marks a file as binary. */
  noBinaryComment?: boolean;
  encrypt?: EncryptOptions;
  trailerExtra?: string;
}

export interface EncryptOptions {
  /** Empty means "opens without a prompt but is permission-restricted". */
  userPassword: string;
  ownerPassword: string;
  /** Permission bits; -1 grants everything, -45 typically denies copy/print. */
  permissions: number;
}

export class PdfDoc {
  private objects: PdfObject[] = [];
  private pages: Ref[] = [];
  /** Extra entries merged into the catalog dictionary. */
  catalogExtra = "";

  /** Reserve a number now, fill the body later (for /Length as an indirect ref). */
  reserve(): Ref {
    this.objects.push({ num: this.objects.length + 1, dict: "null" });
    return ref(this.objects.length);
  }

  fill(target: Ref, dict: string, stream?: Buffer, compressed?: boolean): Ref {
    const object = this.objects[target.num - 1];
    object.dict = dict;
    object.stream = stream;
    object.compressed = compressed;
    return target;
  }

  add(dict: string, stream?: Buffer, compressed?: boolean): Ref {
    return this.fill(this.reserve(), dict, stream, compressed);
  }

  addPage(dict: string): Ref {
    const page = this.add(dict);
    this.pages.push(page);
    return page;
  }

  pageRefs(): Ref[] {
    return this.pages;
  }

  build(options: BuildOptions = {}): Buffer {
    const xrefStyle = options.xref ?? "table";
    // The page tree and catalog are appended last so callers can reference
    // `pagesRef` from page dictionaries before it exists.
    const pagesRef = this.add(
      `<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages
        .map(String)
        .join(" ")}] >>`
    );
    for (const page of this.pages) {
      const object = this.objects[page.num - 1];
      object.dict = object.dict.replace("/Type /Page", `/Type /Page /Parent ${pagesRef}`);
    }
    const catalogRef = this.add(
      `<< /Type /Catalog /Pages ${pagesRef}${this.catalogExtra} >>`
    );

    return xrefStyle === "stream"
      ? this.emitWithXrefStream(catalogRef, options)
      : this.emitWithXrefTable(catalogRef, options);
  }

  // -- emission ------------------------------------------------------------

  private header(options: BuildOptions): Buffer {
    const version = options.version ?? "1.7";
    const comment = options.noBinaryComment
      ? "%plain-ascii-comment\n"
      : "%\xE2\xE3\xCF\xD3\n";
    return Buffer.from(`%PDF-${version}\n${comment}`, "latin1");
  }

  /**
   * Serialize one indirect object. Encryption, when present, applies to the
   * stream payload only — none of these variants put text in strings, so the
   * string-encryption path would be dead code.
   */
  private serialize(object: PdfObject, encrypt?: EncryptState): Buffer {
    const parts: Buffer[] = [Buffer.from(`${object.num} 0 obj\n`, "latin1")];
    if (object.stream) {
      const payload = encrypt
        ? rc4(objectKey(encrypt.key, object.num), object.stream)
        : object.stream;
      parts.push(Buffer.from(`${object.dict}\nstream\n`, "latin1"));
      parts.push(payload);
      parts.push(Buffer.from("\nendstream\nendobj\n", "latin1"));
    } else {
      parts.push(Buffer.from(`${object.dict}\nendobj\n`, "latin1"));
    }
    return Buffer.concat(parts);
  }

  private emitWithXrefTable(catalogRef: Ref, options: BuildOptions): Buffer {
    const chunks: Buffer[] = [this.header(options)];
    let length = chunks[0].length;
    const offsets: number[] = [];

    const documentId = idFromCatalog(catalogRef, this.objects.length);
    let encryptRef: Ref | undefined;
    let encryptState: EncryptState | undefined;
    if (options.encrypt) {
      encryptState = computeEncryption(options.encrypt, documentId);
      // The /Encrypt dictionary is itself never encrypted.
      encryptRef = this.add(encryptDict(options.encrypt, encryptState));
    }

    for (const object of this.objects) {
      offsets[object.num - 1] = length;
      const encryptThis =
        encryptState && object.num !== encryptRef?.num ? encryptState : undefined;
      const buffer = this.serialize(object, encryptThis);
      chunks.push(buffer);
      length += buffer.length;
    }

    const xrefOffset = length;
    const count = this.objects.length + 1;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n++) {
      const offset = options.corruptXref ? offsets[n - 1] + 137 : offsets[n - 1];
      table += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    table +=
      `trailer\n<< /Size ${count} /Root ${catalogRef} /ID [${documentId} ${documentId}]` +
      `${encryptRef ? ` /Encrypt ${encryptRef}` : ""}${options.trailerExtra ?? ""} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(Buffer.from(table, "latin1"));
    return Buffer.concat(chunks);
  }

  /**
   * PDF 1.5+ layout: objects marked `compressed` move into an object stream,
   * and the cross-reference table becomes a compressed binary stream. Both are
   * ubiquitous in modern files and are a common source of "my parser can't read
   * this" — worth having in the corpus explicitly.
   */
  private emitWithXrefStream(catalogRef: Ref, options: BuildOptions): Buffer {
    if (options.encrypt) {
      throw new Error("encryption + xref streams is not a combination we need");
    }
    const compressed = this.objects.filter((o) => o.compressed && !o.stream);
    const topLevel = this.objects.filter((o) => !compressed.includes(o));

    // Build the object stream payload: a header of "num offset" pairs, then the
    // object bodies concatenated.
    let objStmRef: Ref | undefined;
    const indexInStream = new Map<number, number>();
    let objStmObject: PdfObject | undefined;
    if (compressed.length) {
      let header = "";
      let bodies = "";
      compressed.forEach((object, index) => {
        header += `${object.num} ${bodies.length} `;
        bodies += `${object.dict}\n`;
        indexInStream.set(object.num, index);
      });
      const payload = Buffer.from(header + bodies, "latin1");
      const deflated = deflateSync(payload);
      objStmRef = this.reserve();
      objStmObject = this.objects[objStmRef.num - 1];
      objStmObject.dict =
        `<< /Type /ObjStm /N ${compressed.length} /First ${header.length} ` +
        `/Length ${deflated.length} /Filter /FlateDecode >>`;
      objStmObject.stream = deflated;
      topLevel.push(objStmObject);
    }

    const xrefRef = this.reserve();
    const xrefObject = this.objects[xrefRef.num - 1];

    const chunks: Buffer[] = [this.header(options)];
    let length = chunks[0].length;
    const offsets = new Map<number, number>();
    for (const object of topLevel) {
      offsets.set(object.num, length);
      const buffer = this.serialize(object);
      chunks.push(buffer);
      length += buffer.length;
    }

    // Entry format W [1 4 2]: type, then offset-or-stream-number, then
    // generation-or-index-within-stream.
    const total = this.objects.length + 1;
    const entries = Buffer.alloc(total * 7);
    const put = (num: number, type: number, a: number, b: number) => {
      const at = num * 7;
      entries[at] = type;
      entries.writeUInt32BE(a, at + 1);
      entries.writeUInt16BE(b, at + 5);
    };
    put(0, 0, 0, 65535);
    for (const object of this.objects) {
      if (indexInStream.has(object.num) && objStmRef) {
        put(object.num, 2, objStmRef.num, indexInStream.get(object.num)!);
      } else {
        put(object.num, 1, offsets.get(object.num) ?? 0, 0);
      }
    }

    const xrefOffset = length;
    offsets.set(xrefRef.num, length);
    put(xrefRef.num, 1, length, 0);
    const deflated = deflateSync(entries);
    xrefObject.dict =
      `<< /Type /XRef /Size ${total} /W [1 4 2] /Root ${catalogRef} ` +
      `/Length ${deflated.length} /Filter /FlateDecode >>`;
    xrefObject.stream = deflated;
    chunks.push(this.serialize(xrefObject));
    chunks.push(Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`, "latin1"));
    return Buffer.concat(chunks);
  }
}

/**
 * Append a second revision to an existing PDF, the way a signature or an
 * annotation edit does. The appended body carries its own xref whose /Prev
 * points back at the original — readers that only parse the last xref see the
 * new objects, readers that stop at the first see the old ones.
 */
export function appendIncrementalUpdate(
  base: Buffer,
  updated: { num: number; dict: string }[],
  trailer: { size: number; root: string; prev: number }
): Buffer {
  const chunks: Buffer[] = [base];
  let length = base.length;
  const offsets = new Map<number, number>();
  for (const object of updated) {
    offsets.set(object.num, length);
    const buffer = Buffer.from(`${object.num} 0 obj\n${object.dict}\nendobj\n`, "latin1");
    chunks.push(buffer);
    length += buffer.length;
  }

  // One subsection per updated object — they are not contiguous in general.
  let table = "xref\n";
  for (const object of updated) {
    table += `${object.num} 1\n${String(offsets.get(object.num)).padStart(10, "0")} 00000 n \n`;
  }
  table +=
    `trailer\n<< /Size ${trailer.size} /Root ${trailer.root} /Prev ${trailer.prev} >>\n` +
    `startxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(table, "latin1"));
  return Buffer.concat(chunks);
}

/** Byte offset of the last `startxref` value, needed to chain an update onto it. */
export function lastStartxref(data: Buffer): number {
  const tail = data.subarray(Math.max(0, data.length - 2048)).toString("latin1");
  const match = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(tail);
  if (!match) throw new Error("no startxref found in trailer");
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// Standard security handler, revision 2 (40-bit RC4)
// ---------------------------------------------------------------------------

const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
  0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

interface EncryptState {
  key: Buffer;
  o: Buffer;
  u: Buffer;
}

function pad(password: string): Buffer {
  const bytes = Buffer.from(password, "latin1").subarray(0, 32);
  return Buffer.concat([bytes, PAD]).subarray(0, 32);
}

/** RC4 by hand: OpenSSL 3 dropped it from the default provider. */
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const md5 = (...parts: Buffer[]) =>
  createHash("md5").update(Buffer.concat(parts)).digest();

function computeEncryption(options: EncryptOptions, documentId: string): EncryptState {
  const idBytes = Buffer.from(documentId.replace(/[<>]/g, ""), "hex");
  // Algorithm 3: /O is the padded user password RC4'd under a key derived from
  // the owner password.
  const ownerKey = md5(pad(options.ownerPassword)).subarray(0, 5);
  const o = rc4(ownerKey, pad(options.userPassword));

  const p = Buffer.alloc(4);
  p.writeInt32LE(options.permissions);
  // Algorithm 2: the file encryption key.
  const key = md5(pad(options.userPassword), o, p, idBytes).subarray(0, 5);
  // Algorithm 4: /U for revision 2 is simply the padding encrypted with it.
  const u = rc4(key, PAD);
  return { key, o, u };
}

/** Algorithm 1: per-object key = MD5(fileKey + objNum[3] + genNum[2]). */
function objectKey(key: Buffer, num: number): Buffer {
  const extra = Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0]);
  return md5(key, extra).subarray(0, Math.min(key.length + 5, 16));
}

const hex = (buffer: Buffer) => `<${buffer.toString("hex")}>`;

function encryptDict(options: EncryptOptions, state: EncryptState): string {
  return (
    `<< /Filter /Standard /V 1 /R 2 /Length 40 ` +
    `/O ${hex(state.o)} /U ${hex(state.u)} /P ${options.permissions} >>`
  );
}

/** A stable, file-specific /ID — encryption keys are derived from it. */
function idFromCatalog(catalogRef: Ref, objectCount: number): string {
  return `<${createHash("md5")
    .update(`document-intelligence:${catalogRef.num}:${objectCount}`)
    .digest("hex")}>`;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

export const flate = (data: Buffer) => deflateSync(data);

export interface ImageSpec {
  width: number;
  height: number;
  /** Already-encoded stream payload matching `filter`. */
  data: Buffer;
  /** e.g. "/DCTDecode", "/FlateDecode", "/CCITTFaxDecode", or "" for raw. */
  filter: string;
  colorSpace: string;
  bitsPerComponent: number;
  decodeParms?: string;
  /** Emit as a stencil mask (/ImageMask true) rather than an image. */
  imageMask?: boolean;
  /** Write /Length as an indirect reference, the way Sharp copiers do. */
  indirectLength?: boolean;
  decode?: string;
}

/** Add one full-bleed image page. `box` defaults to the image's own size. */
export function addImagePage(
  doc: PdfDoc,
  image: ImageSpec,
  extras: {
    mediaBox?: [number, number, number, number];
    cropBox?: [number, number, number, number];
    rotate?: number;
    pageExtra?: string;
  } = {}
): Ref {
  const lengthRef = image.indirectLength ? doc.reserve() : undefined;
  const dict =
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
    (image.imageMask
      ? `/ImageMask true `
      : `/ColorSpace ${image.colorSpace} /BitsPerComponent ${image.bitsPerComponent} `) +
    (image.decode ? `/Decode ${image.decode} ` : "") +
    (image.filter ? `/Filter ${image.filter} ` : "") +
    (image.decodeParms ? `/DecodeParms ${image.decodeParms} ` : "") +
    `/Length ${lengthRef ? lengthRef : image.data.length} >>`;
  const imageRef = doc.add(dict, image.data);
  if (lengthRef) doc.fill(lengthRef, String(image.data.length));

  const box = extras.mediaBox ?? [0, 0, image.width, image.height];
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  // An /ImageMask paints with the current fill colour, so set it to black.
  const paint = image.imageMask ? "0 g " : "";
  const content = Buffer.from(
    `q ${paint}${w} 0 0 ${h} ${x0} ${y0} cm /Im0 Do Q\n`,
    "latin1"
  );
  const contentRef = doc.add(`<< /Length ${content.length} >>`, content);

  return doc.addPage(
    `<< /Type /Page /MediaBox [${box.join(" ")}] ` +
      (extras.cropBox ? `/CropBox [${extras.cropBox.join(" ")}] ` : "") +
      (extras.rotate ? `/Rotate ${extras.rotate} ` : "") +
      `/Resources << /ProcSet [/PDF /ImageB /ImageC] /XObject << /Im0 ${imageRef} >> >> ` +
      `/Contents ${contentRef} ${extras.pageExtra ?? ""}>>`
  );
}

/**
 * Add a text page. `renderMode` 3 is invisible text — the signature of a
 * scanner's hidden OCR layer, which we need in the corpus because it changes
 * what a provider can extract without doing any OCR of its own.
 */
export function addTextPage(
  doc: PdfDoc,
  lines: string[],
  options: {
    renderMode?: number;
    width?: number;
    height?: number;
    pageExtra?: string;
    mediaBox?: [number, number, number, number];
    cropBox?: [number, number, number, number];
    rotate?: number;
  } = {}
): Ref {
  const box: [number, number, number, number] =
    options.mediaBox ?? [0, 0, options.width ?? 612, options.height ?? 792];
  const [x0, y0, , y1] = box;
  const escaped = lines.map((l) => l.replace(/[\\()]/g, (c) => `\\${c}`));
  const body =
    `BT /F1 11 Tf ${options.renderMode ? `${options.renderMode} Tr ` : ""}` +
    `${x0 + 72} ${y1 - 72} Td 14 TL\n` +
    escaped.map((l) => `(${l}) Tj T*`).join("\n") +
    `\nET\n`;
  void y0;
  const content = Buffer.from(body, "latin1");
  const contentRef = doc.add(`<< /Length ${content.length} >>`, content);
  const fontRef = doc.add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  );
  return doc.addPage(
    `<< /Type /Page /MediaBox [${box.join(" ")}] ` +
      (options.cropBox ? `/CropBox [${options.cropBox.join(" ")}] ` : "") +
      (options.rotate ? `/Rotate ${options.rotate} ` : "") +
      `/Resources << /Font << /F1 ${fontRef} >> >> /Contents ${contentRef} ` +
      `${options.pageExtra ?? ""}>>`
  );
}

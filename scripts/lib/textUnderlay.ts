/**
 * EXPERIMENT — not shipped. Lives in the harness, not in src/, because it has
 * not passed verification.
 *
 * Rebuilding a scanned page with its text drawn *underneath* the raster was
 * tested against a real OCR call and did **not** work: the provider drops text
 * that a full-page image covers. Drawing the text on top at zero alpha (what
 * this file now does) is the obvious next thing to try, but it is untested, so
 * it must not reach users. Keep it here until someone spends the API call.
 *
 * Original rationale follows.
 *
 * A scanner that produces a "searchable PDF" paints the page image and lays its
 * own OCR underneath in text rendering mode 3 — drawn with no fill and no
 * stroke, so it is selectable but invisible. Interfaze's PDF path drops mode-3
 * text entirely (see docs/pdf-edge-cases.md), so those documents come back with
 * no text at all even though the text is right there in the file.
 *
 * pdf.js *can* read it. The repair is therefore to extract that text locally and
 * re-emit each page with the text painted in mode 0 *underneath* a raster of the
 * original page: visually identical, but now in the one form the provider reads.
 *
 * This is deliberately not a general re-encoder. Re-encoding on its own fixes
 * nothing — every image encoding we tested (CCITT G4, JPEG, Flate, bilevel,
 * CMYK, indexed, image masks) returns empty alike, because the provider never
 * OCRs embedded images at all. Only recovering real text changes the outcome.
 */

/** Text placed by `buildTextUnderlayPdf`, in PDF user space (origin bottom-left). */
export interface UnderlayTextItem {
  text: string;
  /** pdf.js text-item transform: [a, b, c, d, e, f]. */
  transform: [number, number, number, number, number, number];
}

export interface UnderlayPage {
  jpeg: Uint8Array;
  /** Page box size in PDF points — what the text coordinates are relative to. */
  width: number;
  height: number;
  /** Raster size in pixels, which is what the image dictionary must declare. */
  pixelWidth: number;
  pixelHeight: number;
  items: UnderlayTextItem[];
}

/** WinAnsi is a byte encoding; anything outside it cannot be written this way. */
function toWinAnsi(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x2019) out += "'";
    else if (code === 0x2018) out += "'";
    else if (code === 0x201c || code === 0x201d) out += '"';
    else if (code === 0x2013 || code === 0x2014) out += "-";
    else if (code >= 0x20 && code <= 0xff) out += char;
    // Anything else is dropped rather than mojibaked — a missing glyph costs
    // one word, a wrong byte can desynchronise the whole string.
  }
  return out;
}

function escapeText(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

/**
 * Assemble the repaired document.
 *
 * Kept free of DOM and Node APIs so it can be unit-tested over fixture bytes and
 * still run in the browser during upload.
 */
export function buildTextUnderlayPdf(pages: UnderlayPage[]): Uint8Array {
  if (pages.length === 0) {
    throw new Error("Cannot build a PDF with no pages");
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const encoder = new TextEncoder();
  const offsets: number[] = [];

  const push = (part: string | Uint8Array) => {
    // Object bodies are ASCII; only the JPEG payloads are binary.
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const beginObject = (n: number) => {
    offsets[n - 1] = length;
    push(`${n} 0 obj\n`);
  };

  push("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");

  // 1 catalog, 2 page tree, 3 font, then page/content/image per page.
  const objectCount = 3 + pages.length * 3;
  const pageObj = (i: number) => 4 + i * 3;
  const contentObj = (i: number) => 5 + i * 3;
  const imageObj = (i: number) => 6 + i * 3;

  beginObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObject(2);
  push(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages
      .map((_, i) => `${pageObj(i)} 0 R`)
      .join(" ")}] >>\nendobj\n`
  );

  beginObject(3);
  push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n"
  );

  pages.forEach((page, i) => {
    beginObject(pageObj(i));
    push(
      `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources << /ProcSet [/PDF /Text /ImageC] ` +
        `/Font << /F1 3 0 R >> /ExtGState << /GS0 << /Type /ExtGState /ca 0 /CA 0 >> >> ` +
        `/XObject << /Im0 ${imageObj(i)} 0 R >> >> ` +
        `/Contents ${contentObj(i)} 0 R >>\nendobj\n`
    );

    // Image first, text second. Draw order matters: a page whose text sits
    // *underneath* a full-page raster comes back with no text at all, while the
    // same text drawn on top survives. The text is kept invisible with a
    // zero-alpha graphics state rather than rendering mode 3, because mode 3 is
    // the very thing the provider discards.
    let content = `q ${num(page.width)} 0 0 ${num(page.height)} 0 0 cm /Im0 Do Q\n`;
    const drawable = page.items.filter((item) => item.text.trim().length > 0);
    if (drawable.length > 0) {
      content += "q /GS0 gs\nBT\n/F1 1 Tf\n";
      for (const item of drawable) {
        const text = escapeText(toWinAnsi(item.text));
        if (!text) continue;
        const [a, b, c, d, e, f] = item.transform;
        // The font size lives in the text matrix, so /F1 stays at size 1.
        content += `${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)} Tm (${text}) Tj\n`;
      }
      content += "ET\nQ\n";
    }

    const contentBytes = encoder.encode(content);
    beginObject(contentObj(i));
    push(`<< /Length ${contentBytes.length} >>\nstream\n`);
    push(contentBytes);
    push("\nendstream\nendobj\n");

    beginObject(imageObj(i));
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} ` +
        `/Height ${page.pixelHeight} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
    );
    push(page.jpeg);
    push("\nendstream\nendobj\n");
  });

  const xrefOffset = length;
  push(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= objectCount; n++) {
    push(`${String(offsets[n - 1]).padStart(10, "0")} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`
  );

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

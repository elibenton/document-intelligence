import { describe, expect, it } from "vitest";
import {
  hasPdfHeader,
  isPdfUpload,
  preflightPdf,
  PDF_INTERFAZE_SAFE_BYTES,
} from "./pdfPreflight";
import { formatBytes } from "./formatBytes";

// ---------------------------------------------------------------------------
// Fixture bytes
// ---------------------------------------------------------------------------

const latin1 = (text: string): Uint8Array =>
  Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

/** The opening bytes of a real PDF, enough for the header sniff. */
const PDF_HEADER = latin1("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\n");

/** A Sharp copier writes trailing text on the header line; still a PDF. */
const SHARP_HEADER = latin1("%PDF-1.4 Sharp Scanned ImagePDF\n%Sharp Non-Encryption\n");

const file = (bytes: Uint8Array, name = "sample.pdf"): File =>
  new File([bytes as BlobPart], name, { type: "application/pdf" });

describe("hasPdfHeader", () => {
  it("accepts a conventional header", () => {
    expect(hasPdfHeader(PDF_HEADER)).toBe(true);
  });

  it("accepts the copier header that carries trailing text", () => {
    expect(hasPdfHeader(SHARP_HEADER)).toBe(true);
  });

  it("accepts a header offset into the first block, as the spec allows", () => {
    expect(hasPdfHeader(latin1("junk junk junk %PDF-1.5\n"))).toBe(true);
  });

  it("rejects bytes with no header at all", () => {
    expect(hasPdfHeader(latin1("PK\x03\x04 this is a zip"))).toBe(false);
  });
});

describe("isPdfUpload", () => {
  it("matches on MIME type", () => {
    expect(isPdfUpload(new File([], "x", { type: "application/pdf" }))).toBe(true);
  });

  it("matches on extension when the browser gives no type", () => {
    expect(isPdfUpload(new File([], "scan.PDF", { type: "" }))).toBe(true);
  });

  it("does not match other documents", () => {
    expect(isPdfUpload(new File([], "notes.docx", { type: "" }))).toBe(false);
  });
});

describe("formatBytes", () => {
  it("uses KB below a megabyte and never rounds to zero", () => {
    expect(formatBytes(400)).toBe("1 KB");
    expect(formatBytes(417_644)).toBe("418 KB");
  });

  it("uses one decimal place until ten megabytes", () => {
    expect(formatBytes(2_120_000)).toBe("2.1 MB");
    expect(formatBytes(21_000_000)).toBe("21 MB");
  });
});

// ---------------------------------------------------------------------------
// Byte-level rejections. These all resolve before pdf.js is loaded, so they run
// anywhere.
// ---------------------------------------------------------------------------

describe("preflightPdf byte-level gates", () => {
  it("rejects an empty file", async () => {
    const result = await preflightPdf(file(new Uint8Array()));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("empty");
  });

  it("rejects a file that is not a PDF despite its name", async () => {
    const result = await preflightPdf(file(latin1("PK\x03\x04not a pdf at all")));
    expect(result.ok === false && result.code).toBe("invalid_pdf");
  });

  it("rejects a file over the provider's transfer ceiling", async () => {
    // The size is spoofed rather than allocated: the ceiling is now the 80 MB
    // URL limit, and a real buffer that big is an absurd price for one assert.
    const oversize = file(PDF_HEADER);
    Object.defineProperty(oversize, "size", {
      value: PDF_INTERFAZE_SAFE_BYTES + 1,
    });
    const result = await preflightPdf(oversize);
    expect(result.ok === false && result.code).toBe("provider_size_limit");
    expect(result.ok === false && result.message).toContain("70 MB");
  });
});

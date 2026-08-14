import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PROVIDER_URL_SAFE_BYTES } from "../../convex/interfazeLimits";
import { formatBytes } from "./formatBytes";

/**
 * Client-side gate for PDF uploads.
 *
 * Everything checked here is a failure mode measured against the real provider
 * and written up in docs/pdf-edge-cases.md.
 *
 * ## The text-layer check used to live here, and was wrong
 *
 * This file used to sample the first five pages, classify each as readable or
 * scanned, and warn that a scanned document "will most likely come back with
 * nothing". That was true when it was written: the pipeline sent the whole file
 * to a model completion that read the embedded text layer and nothing else.
 *
 * It stopped being true when the parse stage moved to Interfaze's dedicated OCR
 * task (`ocrDocument` in convex/processingNode.ts). Re-measured against the live
 * pipeline: `test-corpus/Matt smith 2022 contract.pdf` — no text layer, no
 * embedded fonts, five iPhone-camera JPEGs, the most unambiguous scan in the
 * corpus — returns 7,769 characters across 128 blocks, correctly. The check was
 * turning away documents that work.
 *
 * The whole classifier went with it rather than being relaxed: a check whose
 * premise is gone has no threshold worth tuning. What is left are the limits
 * that are still real — size, page count, page geometry — none of which OCR
 * changed.
 *
 * Nothing here re-encodes the file. Re-encoding was tried and measured: every
 * image encoding fails identically, so a repaired file is just a slower way to
 * get the same result.
 */

/**
 * The ceiling is the provider's 80 MB URL limit, not the 20 MB file-object one.
 * Between the two, the pipeline switches transport rather than refusing the
 * document (convex/interfaze.ts:fileUrlContent) — an oversized PDF now costs
 * more to read instead of being rejected at upload.
 */
export const PDF_INTERFAZE_SAFE_BYTES = PROVIDER_URL_SAFE_BYTES;

/**
 * The 50-page truncation warning was removed here for the same reason as the
 * text-layer check, and it is worth recording why rather than just deleting it.
 *
 * The original measurement was real: a 45-page file came back complete, while
 * 60, 150 and 520-page files all came back with exactly 50 pages and no error.
 * Re-measured against every document in the deployment past 50 pages, that
 * ceiling is gone — 156 pages stored 156 pages with text through page 155, and
 * 89, 75, 65, 62, 62 and 60-page files all read in full. The one long document
 * that comes back mostly empty (93 pages, 4 with text) is a redacted scan,
 * which is a different failure and not a truncation at 50.
 *
 * The pattern both share: a provider limit measured when it was true, encoded
 * as a constant, and never re-measured after the pipeline moved underneath it.
 * Anything added here should carry the date and method of its measurement.
 */

/**
 * Page-dimension ceilings, re-measured 2026-08-14 against the live pipeline by
 * pushing the geom-large-page-* fixtures through it and reading back what the
 * parse stage stored:
 *
 *   1,584pt (22in)  → parsed, 350 chars, full marker text.
 *   5,000pt (69in)  → parsed, 350 chars, full marker text.
 *  14,400pt (200in) → failed. Interfaze billed 561 OCR tokens and returned
 *                     nothing; the stage reports it as a provider-side failure.
 *
 * The old ceilings — warn at 1,584, hard-reject at 5,000 — were set when a
 * 69-inch page "lost most of its text". It no longer does: 5,000pt reads
 * completely, so the hard reject was refusing a document that works. The block
 * moves to the size that actually fails.
 *
 * Note what is *not* measured: anything between 5,000 and 14,400. The warning
 * threshold sits at 5,000 rather than somewhere interpolated, because that is
 * the largest size proven to read cleanly, and a warning is the honest way to
 * say "past here we have not checked".
 */
export const PDF_WARN_PAGE_POINTS = 5_000;
export const PDF_MAX_PAGE_POINTS = 14_400;

/**
 * Pages inspected for their dimensions. The geometry ceiling is a property of
 * the page box, which is uniform in practice, so a sample answers it.
 */
const GEOMETRY_SAMPLE_PAGES = 5;

export type PdfWarningCode = "large_pages" | "form_fields_ignored";

export interface PdfWarning {
  code: PdfWarningCode;
  message: string;
}

export type PdfPreflightResult =
  | {
      ok: true;
      code: "ready";
      pageCount: number;
      message: string;
      warnings: PdfWarning[];
    }
  | {
      ok: false;
      code:
        | "empty"
        | "invalid_pdf"
        | "password_protected"
        | "permissions_restricted"
        | "provider_size_limit"
        | "oversized_pages";
      pageCount: number | null;
      message: string;
    };

function extensionOf(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

export function isPdfUpload(file: File): boolean {
  return (
    file.type.toLowerCase() === "application/pdf" ||
    extensionOf(file.name) === "pdf"
  );
}

/** PDF headers may legally appear within the first 1,024 bytes. */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.max(0, bytes.length - 4);
  for (let index = 0; index < limit; index += 1) {
    if (
      bytes[index] === 0x25 &&
      bytes[index + 1] === 0x50 &&
      bytes[index + 2] === 0x44 &&
      bytes[index + 3] === 0x46 &&
      bytes[index + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

function isPasswordError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "PasswordException" ||
    /password|encrypted/i.test(error.message)
  );
}

// ---------------------------------------------------------------------------

export async function preflightPdf(file: File): Promise<PdfPreflightResult> {
  if (file.size === 0) {
    return {
      ok: false,
      code: "empty",
      pageCount: null,
      message: "This PDF is empty.",
    };
  }

  const header = new Uint8Array(await file.slice(0, 1_024).arrayBuffer());
  if (!hasPdfHeader(header)) {
    return {
      ok: false,
      code: "invalid_pdf",
      pageCount: null,
      message:
        "This file is named as a PDF, but its contents do not contain a PDF header.",
    };
  }

  if (file.size > PDF_INTERFAZE_SAFE_BYTES) {
    return {
      ok: false,
      code: "provider_size_limit",
      pageCount: null,
      message: `This ${formatBytes(file.size)} PDF is over the ${formatBytes(
        PDF_INTERFAZE_SAFE_BYTES
      )} limit we can send for reading. Split or compress it and try again.`,
    };
  }

  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    stopAtErrors: true,
  });

  try {
    const pdf = await loadingTask.promise;
    try {
      const pageCount = pdf.numPages;
      if (pageCount < 1) {
        return {
          ok: false,
          code: "invalid_pdf",
          pageCount: null,
          message: "This PDF does not contain any pages.",
        };
      }

      const { info } = (await pdf.getMetadata()) as {
        info: { EncryptFilterName?: string | null; IsAcroFormPresent?: boolean };
      };

      // An encrypted-but-openable file (owner password only, no user password)
      // opens here without a prompt but returns nothing from the provider.
      if (info?.EncryptFilterName) {
        return {
          ok: false,
          code: "permissions_restricted",
          pageCount,
          message:
            "This PDF has security restrictions that block copying its text. " +
            "Open it and save or print an unrestricted copy, then upload that.",
        };
      }

      const warnings: PdfWarning[] = [];

      // -- geometry ------------------------------------------------------
      // Only the viewport is read now. The `getOperatorList()` call that used
      // to sit here — decoding every content stream on five pages to classify
      // its text layer — went with the check it fed, which also makes this
      // preflight markedly cheaper on a large file.
      let widest = 0;
      const sampleCount = Math.min(pageCount, GEOMETRY_SAMPLE_PAGES);

      for (let index = 1; index <= sampleCount; index += 1) {
        const page = await pdf.getPage(index);
        try {
          const viewport = page.getViewport({ scale: 1 });
          widest = Math.max(widest, viewport.width, viewport.height);
        } finally {
          page.cleanup();
        }
      }

      if (widest > PDF_MAX_PAGE_POINTS) {
        return {
          ok: false,
          code: "oversized_pages",
          pageCount,
          message:
            `This PDF's pages are ${(widest / 72).toFixed(0)} inches across. At that size ` +
            `the reading pass comes back empty, so there is nothing to show. Export it ` +
            `at a normal page size and try again.`,
        };
      }
      if (widest > PDF_WARN_PAGE_POINTS) {
        warnings.push({
          code: "large_pages",
          message:
            `Pages are unusually large (${(widest / 72).toFixed(0)} inches across). ` +
            `Pages up to 69 inches read cleanly; past that we haven't measured, so ` +
            `some text may be missed.`,
        });
      }

      // -- content the provider ignores ----------------------------------
      if (info?.IsAcroFormPresent) {
        warnings.push({
          code: "form_fields_ignored",
          message:
            "This is a fillable form. Text typed into its fields is not read — " +
            "only text printed on the page. Flatten the form (print to PDF) to include the answers.",
        });
      }

      return {
        ok: true,
        code: "ready",
        pageCount,
        message: `${pageCount} page${pageCount === 1 ? "" : "s"} · ${formatBytes(
          file.size
        )}${warnings.length === 0 ? " · ready" : ""}`,
        warnings,
      };
    } finally {
      await pdf.destroy();
    }
  } catch (error) {
    await loadingTask.destroy();
    if (isPasswordError(error)) {
      return {
        ok: false,
        code: "password_protected",
        pageCount: null,
        message:
          "This PDF is password-protected. Remove the password and upload an unlocked copy.",
      };
    }
    return {
      ok: false,
      code: "invalid_pdf",
      pageCount: null,
      message:
        "This PDF is damaged or incomplete and could not be opened. Export a fresh copy and try again.",
    };
  }
}

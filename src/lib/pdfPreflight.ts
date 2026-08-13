import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * Client-side gate for PDF uploads.
 *
 * Everything checked here is a failure mode measured against the real provider
 * and written up in docs/pdf-edge-cases.md. The headline finding is that our OCR
 * provider does not OCR pictures inside a PDF at all — it reads the embedded
 * text layer and nothing else. A scanned document therefore comes back with no
 * text, no error, and a bill for the tokens. That is invisible at upload time
 * unless we look, so we look.
 *
 * Nothing here re-encodes the file. Re-encoding was tried and measured: every
 * image encoding fails identically, so a repaired file is just a slower way to
 * get the same empty result.
 */

/**
 * Interfaze accepts file objects up to 20 MB. PDFs currently use a structured
 * file part (for visual grounding), so keep headroom for provider accounting.
 */
export const PDF_INTERFAZE_SAFE_BYTES = 18_000_000;

/**
 * Measured, not documented: a 45-page file came back complete, while 60, 150 and
 * 520-page files all came back with exactly 50 pages and no error. Anything past
 * this is silently dropped.
 */
export const PDF_PROVIDER_PAGE_LIMIT = 50;

/**
 * Page-dimension ceilings, also measured. A 22-inch page reads fine, a 69-inch
 * page loses most of its text, and a 200-inch page returns nothing at all.
 */
export const PDF_WARN_PAGE_POINTS = 1_584;
export const PDF_MAX_PAGE_POINTS = 5_000;

/** Pages inspected for a text layer. Enough to classify, cheap enough to run. */
const TEXT_LAYER_SAMPLE_PAGES = 5;

/** An image this much of the page width is treated as covering it. */
const FULL_PAGE_IMAGE_RATIO = 0.9;

export type PdfWarningCode =
  | "no_text_layer"
  | "page_limit_truncation"
  | "large_pages"
  | "form_fields_ignored"
  | "annotations_ignored";

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

export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
}

function isPasswordError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "PasswordException" ||
    /password|encrypted/i.test(error.message)
  );
}

// ---------------------------------------------------------------------------
// Text-layer classification
// ---------------------------------------------------------------------------

export type PageReadability =
  /** Painted text the provider will extract. */
  | "readable"
  /** Text exists but is invisible (a scanner's own OCR) — the provider drops it. */
  | "hidden_text"
  /** Text exists but a full-page image covers it — the provider drops it too. */
  | "covered_by_image"
  /** No text at all: a pure scan. */
  | "image_only";

/**
 * Decide, for a single page, whether the provider will get any text from it.
 *
 * Three separate measurements landed on the same answer for scanned documents,
 * so all three are checked: text rendered in mode 3 or 7 is invisible and gets
 * dropped, text sitting under a page-sized image gets dropped, and a page with
 * no text at all was never going to yield any.
 */
export function classifyPage(
  ops: { fnArray: number[]; argsArray: unknown[] },
  codes: {
    setTextRenderingMode: number;
    showText: number;
    showSpacedText: number;
    nextLineShowText: number;
    nextLineSetSpacingShowText: number;
    paintImageXObject: number;
    /** Dropped in pdf.js 5, still emitted by older builds. */
    paintJpegXObject?: number;
    paintImageMaskXObject: number;
    transform: number;
    save: number;
    restore: number;
  },
  pageWidth: number,
  pageHeight: number
): PageReadability {
  const textOps = new Set([
    codes.showText,
    codes.showSpacedText,
    codes.nextLineShowText,
    codes.nextLineSetSpacingShowText,
  ]);
  const imageOps = new Set(
    [
      codes.paintImageXObject,
      codes.paintJpegXObject,
      codes.paintImageMaskXObject,
    ].filter((code): code is number => code !== undefined)
  );

  let renderMode = 0;
  let visibleGlyphs = 0;
  let hiddenGlyphs = 0;
  let fullPageImage = false;

  // Track just enough of the graphics state to know how big a painted image is.
  // Scale is all we need, so the matrix is kept as [scaleX, scaleY].
  let ctm: [number, number] = [1, 1];
  const stack: [number, number][] = [];

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const op = ops.fnArray[i];
    const args = ops.argsArray[i] as number[] | undefined;

    if (op === codes.save) {
      stack.push([...ctm] as [number, number]);
      continue;
    }
    if (op === codes.restore) {
      ctm = stack.pop() ?? [1, 1];
      continue;
    }
    if (op === codes.transform && args && args.length >= 4) {
      // |a| and |d| carry the scale; skew is rare enough on a page-filling image
      // that the magnitude of the row is a good enough stand-in.
      const scaleX = Math.hypot(args[0] ?? 0, args[1] ?? 0);
      const scaleY = Math.hypot(args[2] ?? 0, args[3] ?? 0);
      ctm = [ctm[0] * scaleX, ctm[1] * scaleY];
      continue;
    }
    if (op === codes.setTextRenderingMode) {
      renderMode = Number(args?.[0] ?? 0);
      continue;
    }
    if (imageOps.has(op)) {
      if (
        Math.abs(ctm[0]) >= pageWidth * FULL_PAGE_IMAGE_RATIO &&
        Math.abs(ctm[1]) >= pageHeight * FULL_PAGE_IMAGE_RATIO
      ) {
        fullPageImage = true;
      }
      continue;
    }
    if (textOps.has(op)) {
      // One glyph run is enough to classify; exact counts do not matter.
      if (renderMode === 3 || renderMode === 7) hiddenGlyphs += 1;
      else visibleGlyphs += 1;
    }
  }

  if (visibleGlyphs > 0) return fullPageImage ? "covered_by_image" : "readable";
  if (hiddenGlyphs > 0) return "hidden_text";
  return "image_only";
}

const UNREADABLE_ADVICE =
  "Run text recognition on it first (Preview › Export as PDF with OCR, Acrobat › Recognise Text, or your scanner's “searchable PDF” setting), then upload the recognised copy.";

function textLayerWarning(
  unreadable: PageReadability[],
  sampled: number,
  pageCount: number
): PdfWarning | null {
  if (unreadable.length === 0) return null;
  const everyPage = unreadable.length === sampled;
  const scope = everyPage
    ? pageCount === 1
      ? "This page has"
      : "Every page we checked has"
    : `${unreadable.length} of the first ${sampled} pages have`;

  const kind = unreadable.includes("hidden_text")
    ? "text that is stored invisibly beneath the scan"
    : "no text in it — only a picture of one";

  return {
    code: "no_text_layer",
    message:
      `${scope} ${kind}. We read the text stored inside a PDF; we cannot read ` +
      `words that only exist as pixels, so this document will most likely come ` +
      `back with nothing. ${UNREADABLE_ADVICE}`,
  };
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
      message: `This ${formatBytes(file.size)} PDF is over the current 18 MB safe limit. Compress it below 18 MB and try again.`,
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
      let widest = 0;
      const sampleCount = Math.min(pageCount, TEXT_LAYER_SAMPLE_PAGES);
      const unreadable: PageReadability[] = [];
      let annotated = false;

      for (let index = 1; index <= sampleCount; index += 1) {
        const page = await pdf.getPage(index);
        try {
          const viewport = page.getViewport({ scale: 1 });
          widest = Math.max(widest, viewport.width, viewport.height);

          const readability = classifyPage(
            await page.getOperatorList(),
            pdfjs.OPS,
            viewport.width,
            viewport.height
          );
          if (readability !== "readable") unreadable.push(readability);

          if (!annotated) {
            const annotations = await page.getAnnotations();
            annotated = annotations.some(
              (annotation: { contents?: string; subtype?: string }) =>
                annotation.subtype !== "Link" && Boolean(annotation.contents)
            );
          }
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
            `This PDF's pages are ${(widest / 72).toFixed(0)} inches across, which is too ` +
            `large to read reliably — text is dropped at this size. Export it at a ` +
            `normal page size (A4, Letter, or up to about 22 inches) and try again.`,
        };
      }
      if (widest > PDF_WARN_PAGE_POINTS) {
        warnings.push({
          code: "large_pages",
          message:
            `Pages are unusually large (${(widest / 72).toFixed(0)} inches across). ` +
            `Some text may be missed; a normal page size reads more reliably.`,
        });
      }

      // -- text layer ----------------------------------------------------
      const layerWarning = textLayerWarning(unreadable, sampleCount, pageCount);
      if (layerWarning) warnings.push(layerWarning);

      // -- page count ----------------------------------------------------
      if (pageCount > PDF_PROVIDER_PAGE_LIMIT) {
        warnings.push({
          code: "page_limit_truncation",
          message:
            `Only the first ${PDF_PROVIDER_PAGE_LIMIT} of ${pageCount} pages will be read — ` +
            `the rest are dropped without warning. Split this into files of ` +
            `${PDF_PROVIDER_PAGE_LIMIT} pages or fewer to capture all of it.`,
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
      if (annotated) {
        warnings.push({
          code: "annotations_ignored",
          message:
            "Comments and sticky notes in this PDF are not read — only the page text itself.",
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

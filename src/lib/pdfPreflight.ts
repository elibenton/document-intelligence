import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * Interfaze accepts file objects up to 20 MB. PDFs currently use a structured
 * file part (for visual grounding), so keep headroom for provider accounting.
 */
export const PDF_INTERFAZE_SAFE_BYTES = 18_000_000;
export const PDF_LARGE_PAGE_COUNT = 100;

export type PdfPreflightResult =
  | {
      ok: true;
      pageCount: number;
      message: string;
    }
  | {
      ok: false;
      code:
        | "empty"
        | "invalid_pdf"
        | "password_protected"
        | "provider_size_limit";
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

function formatBytes(bytes: number): string {
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
    const pageCount = pdf.numPages;
    await pdf.destroy();
    if (pageCount < 1) {
      return {
        ok: false,
        code: "invalid_pdf",
        pageCount: null,
        message: "This PDF does not contain any pages.",
      };
    }

    return {
      ok: true,
      pageCount,
      message: `${pageCount} page${pageCount === 1 ? "" : "s"} · ${formatBytes(
        file.size
      )}${
        pageCount >= PDF_LARGE_PAGE_COUNT
          ? " · large document; rendering will continue in the background"
          : " · ready"
      }`,
    };
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

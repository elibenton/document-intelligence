import { useCallback, useState } from "react";
import { usePdfDocument } from "../../lib/pdfDocument";
import { PdfPageCanvas } from "./PdfPageCanvas";
import { PdfPageSkeleton } from "./PdfPageSkeleton";

/**
 * One page of a document at card size, drawn client-side — the citation
 * surfaces' page renderer.
 *
 * The quote hover card and the evidence carousel both show a single page with a
 * highlight boxed on it. They used to show a server-rendered PNG; when that
 * pipeline was removed they degraded to "Preview unavailable" and a blank white
 * rectangle respectively. This draws the real page with pdf.js from the shared
 * document cache (src/lib/pdfDocument.ts), so a preview and the full viewer
 * showing the same document also share one fetch, one worker, and the browser's
 * HTTP cache.
 *
 * An image document is drawn directly with an <img>. A DOCX has no drawable
 * file, and a PDF that fails to open is not worth an error card here — both
 * fall back to the bare white page the geometry was extracted against, with
 * the overlay still exact.
 *
 * Two coordinate spaces meet here, deliberately kept apart the same way
 * PdfViewer keeps them: the surface is sized from the page's true pdf.js
 * dimensions once known (stored OCR dimensions have been observed wrong in one
 * axis), while `overlay` is handed a scale derived from the *stored* width,
 * which is the space the block bboxes live in.
 */
export function SinglePagePreview({
  fileUrl,
  mediaType,
  pageNumber,
  width,
  pageWidth,
  pageHeight,
  rotation = 0,
  overlay,
}: {
  fileUrl: string | null;
  mediaType: string | undefined;
  /** 0-based, matching the stored geometry rows. */
  pageNumber: number;
  /** CSS width budget for the page box. */
  width: number;
  /** Stored geometry dimensions (the `pages` row) — the bbox coordinate space. */
  pageWidth?: number | null;
  pageHeight?: number | null;
  rotation?: 0 | 90 | 180 | 270;
  /**
   * Highlight layer, given the factor that maps stored-geometry pixels to CSS
   * pixels. Rendered inside the rotated surface, above the page.
   */
  overlay?: (scale: number) => React.ReactNode;
}) {
  const isPdf = mediaType === "pdf";
  const isImage = mediaType === "image";
  const { pdf, error } = usePdfDocument(isPdf ? fileUrl : null);

  // The page's true size as pdf.js reports it — the authority on aspect ratio.
  const [pdfSize, setPdfSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  // A measurement belongs to the document that produced it; reset during
  // render, not in an effect (see the same pattern in PdfViewer).
  const [seenPdf, setSeenPdf] = useState(pdf);
  if (pdf !== seenPdf) {
    setSeenPdf(pdf);
    setPdfSize(null);
  }
  const handlePageSize = useCallback(
    (_pageNumber: number, size: { width: number; height: number }) => {
      setPdfSize((previous) =>
        previous &&
        previous.width === size.width &&
        previous.height === size.height
          ? previous
          : size
      );
    },
    []
  );

  const sourceWidth = pdfSize?.width ?? pageWidth ?? width;
  const sourceHeight = pdfSize?.height ?? pageHeight ?? width * (11 / 8.5);
  const sideways = rotation === 90 || rotation === 270;
  const fitScale = width / (sideways ? sourceHeight : sourceWidth);
  const surfaceWidth = sourceWidth * fitScale;
  const surfaceHeight = sourceHeight * fitScale;
  const boxHeight = sideways ? surfaceWidth : surfaceHeight;
  const overlayScale =
    pageWidth && pageWidth > 0 ? surfaceWidth / pageWidth : fitScale;

  return (
    <div className="relative" style={{ width, height: boxHeight }}>
      {/* The surface stays in source orientation; rotating this one element
          moves pixels and overlay together. */}
      <div
        className="absolute left-1/2 top-1/2 bg-white"
        style={{
          width: surfaceWidth,
          height: surfaceHeight,
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        }}
      >
        {isImage && fileUrl ? (
          <img
            src={fileUrl}
            alt=""
            width={surfaceWidth}
            height={surfaceHeight}
            className="block h-full w-full object-contain"
          />
        ) : pdf ? (
          <PdfPageCanvas
            pdf={pdf}
            pageNumber={pageNumber + 1}
            cssWidth={surfaceWidth}
            cssHeight={surfaceHeight}
            onPageSize={handlePageSize}
          />
        ) : isPdf && fileUrl && !error ? (
          <PdfPageSkeleton
            pageNumber={pageNumber + 1}
            label={`Loading page ${pageNumber + 1}`}
          />
        ) : null}
        {overlay && (
          <div className="pointer-events-none absolute inset-0 z-10">
            {overlay(overlayScale)}
          </div>
        )}
      </div>
    </div>
  );
}

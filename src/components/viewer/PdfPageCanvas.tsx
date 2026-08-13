import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

/**
 * One page of a PDF, drawn in the browser at the size it is displayed.
 *
 * This replaces the server-rendered PNG that convex/renderPages.ts used to
 * produce. Those rasters were ~2.1 MB per page — roughly 22x the source PDF's
 * bytes for the same page — and no server code ever read them, so the pixels
 * travelled to the browser the long way round. Drawing here fetches only the
 * page's own bytes and paints in ~80-120ms.
 *
 * The trade the pre-rendered design was avoiding is real and handled here: a
 * render task must be cancelled when the page scrolls out of view, or fast
 * scrolling queues work faster than it completes.
 */
export function PdfPageCanvas({
  pdf,
  pageNumber,
  cssWidth,
  cssHeight,
  onPainted,
  onPageSize,
}: {
  pdf: PDFDocumentProxy;
  /** 1-indexed, matching pdf.js. */
  pageNumber: number;
  cssWidth: number;
  cssHeight: number;
  onPainted?: (pageNumber: number) => void;
  /**
   * The page's intrinsic size, reported as soon as pdf.js hands over the page.
   * The caller sizes the surface from it — see the note in ImagePdfViewer on
   * why the stored OCR dimensions cannot be trusted for that.
   */
  onPageSize?: (
    pageNumber: number,
    size: { width: number; height: number }
  ) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    if (!cssWidth) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    setPainted(false);

    void (async () => {
      let page;
      try {
        page = await pdf.getPage(pageNumber);
      } catch {
        return; // Document was destroyed while this page was in flight.
      }
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const base = page.getViewport({ scale: 1 });
      onPageSize?.(pageNumber, { width: base.width, height: base.height });
      // Cap the device pixel ratio: a 3x canvas on a retina display triples the
      // memory for a difference nobody sees at this size.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({
        scale: (cssWidth / base.width) * dpr,
      });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      try {
        task = page.render({ canvas, viewport });
        await task.promise;
        if (!cancelled) {
          setPainted(true);
          onPainted?.(pageNumber);
        }
      } catch (error) {
        // Scrolling past a page cancels its render. That is the normal path,
        // not a failure.
        const name = error instanceof Error ? error.name : "";
        if (name !== "RenderingCancelledException" && !cancelled) throw error;
      } finally {
        page.cleanup();
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, cssWidth, onPainted, onPageSize]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="block select-none"
        style={{ width: cssWidth, height: cssHeight }}
        aria-label={`Page ${pageNumber}`}
      />
      {!painted && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs text-muted-foreground">
            Rendering page {pageNumber}…
          </span>
        </div>
      )}
    </>
  );
}

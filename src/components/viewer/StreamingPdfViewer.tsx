import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * PROTOTYPE INSTRUMENTATION — records the byte ranges pdf.js actually asks for,
 * so "it streams" is a measurement and not an assumption. Delete with the
 * prototype. Installed at module scope because pdf.js issues its first request
 * before any component effect runs.
 */
declare global {
  interface Window {
    __pdfRanges?: { range: string; status: number; contentRange: string | null }[];
  }
}
if (typeof window !== "undefined" && !window.__pdfRanges) {
  window.__pdfRanges = [];
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    const response = await originalFetch(input as RequestInfo, init);
    if (url.includes("/api/storage/")) {
      window.__pdfRanges?.push({
        range: headers.get("range") ?? "none",
        status: response.status,
        contentRange: response.headers.get("content-range"),
      });
    }
    return response;
  };
}

/**
 * PROTOTYPE — client-side counterpart to ImagePdfViewer.
 *
 * ImagePdfViewer displays PNGs that convex/renderPages.ts rasterized ahead of
 * time, so no page can be shown until the server has rendered it. This renders
 * the original PDF in the browser instead: pdf.js streams it over HTTP range
 * requests (Convex storage answers with 206 + Content-Range), so the first page
 * paints after a few tens of KB rather than after a whole-document job, and a
 * jump to page 90 fetches only what page 90 needs.
 *
 * Only pages near the viewport hold a canvas, per the pdf.js FAQ's guidance —
 * rendering every page at once is what exhausts memory. Render tasks are
 * cancelled when a page scrolls away, which is the failure mode the
 * pre-rendered design was written to avoid; handling it explicitly here is the
 * cost of dropping the server rasterizer.
 */

const NEAR_WINDOW = 2;
const TARGET_CSS_WIDTH = 900;

export interface StreamingPdfViewerProps {
  url: string;
  /** Reports timings so the two viewers can be compared honestly. */
  onMetric?: (name: string, ms: number, detail?: string) => void;
  jumpToPage?: number;
}

export function StreamingPdfViewer({
  url,
  onMetric,
  jumpToPage,
}: StreamingPdfViewerProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [aspect, setAspect] = useState(11 / 8.5);
  const [nearPages, setNearPages] = useState<Set<number>>(new Set([1]));
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    const task = pdfjs.getDocument({
      url,
      // Force true lazy loading. disableStream:false makes pdf.js consume one
      // progressive GET of the entire file — measured at 10.7s to open a 15MB
      // 156-page contract. Disabling the stream makes it fetch the trailer and
      // then only the byte ranges each rendered page needs; disableAutoFetch
      // stops it backfilling the remainder once the first page is up.
      disableRange: false,
      disableStream: true,
      disableAutoFetch: true,
    });
    task.promise
      .then(async (doc) => {
        if (cancelled) return;
        onMetric?.("document opened", performance.now() - started, `${doc.numPages}pp`);
        setPdf(doc);
        setPageCount(doc.numPages);
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (!cancelled) setAspect(vp.height / vp.width);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url, onMetric]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pageCount) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setNearPages((previous) => {
          const next = new Set(previous);
          let changed = false;
          for (const entry of entries) {
            const page = Number(
              (entry.target as HTMLElement).dataset.page ?? "0"
            );
            if (!page) continue;
            for (let p = page - NEAR_WINDOW; p <= page + NEAR_WINDOW; p++) {
              if (p >= 1 && p <= pageCount && entry.isIntersecting && !next.has(p)) {
                next.add(p);
                changed = true;
              }
            }
          }
          return changed ? next : previous;
        });
      },
      { root: container, rootMargin: "200% 0px" }
    );
    for (const el of pageRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [pageCount]);

  useEffect(() => {
    if (!jumpToPage) return;
    pageRefs.current.get(jumpToPage)?.scrollIntoView({ block: "start" });
  }, [jumpToPage]);

  const registerPage = useCallback((page: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(page, el);
    else pageRefs.current.delete(page);
  }, []);

  const pageNumbers = useMemo(
    () => Array.from({ length: pageCount }, (_, i) => i + 1),
    [pageCount]
  );

  if (error) {
    return (
      <div className="p-4 text-sm text-red-600">
        Could not open the PDF: {error}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto bg-neutral-100">
      {!pdf && <div className="p-4 text-sm text-neutral-500">Opening…</div>}
      {pageNumbers.map((pageNumber) => (
        <div
          key={pageNumber}
          data-page={pageNumber}
          ref={(el) => registerPage(pageNumber, el)}
          className="mx-auto my-4 bg-white shadow"
          style={{ width: TARGET_CSS_WIDTH, aspectRatio: `1 / ${aspect}` }}
        >
          {pdf && nearPages.has(pageNumber) ? (
            <StreamingPage
              pdf={pdf}
              pageNumber={pageNumber}
              cssWidth={TARGET_CSS_WIDTH}
              onMetric={onMetric}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-neutral-400">
              {pageNumber}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function StreamingPage({
  pdf,
  pageNumber,
  cssWidth,
  onMetric,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  cssWidth: number;
  onMetric?: (name: string, ms: number, detail?: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | undefined;
    const started = performance.now();

    void (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = "100%";
      canvas.style.height = "100%";

      const context = canvas.getContext("2d");
      if (!context) return;
      task = page.render({ canvas, viewport });
      try {
        await task.promise;
        if (!cancelled) {
          onMetric?.(`page ${pageNumber} painted`, performance.now() - started);
        }
      } catch (e) {
        // A cancelled render is the expected outcome of scrolling past a page.
        if (!(e instanceof Error) || e.name !== "RenderingCancelledException") {
          throw e;
        }
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, cssWidth, onMetric]);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}

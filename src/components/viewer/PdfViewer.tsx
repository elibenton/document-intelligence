import { useState, useCallback, useRef, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface PdfViewerProps {
  url: string;
  highlightText?: string;
  onVisiblePageChange?: (pageNumber: number) => void;
  renderOverlay?: (
    pageNumber: number,
    dimensions: { width: number; height: number }
  ) => React.ReactNode;
}

export function PdfViewer({
  url,
  highlightText,
  onVisiblePageChange,
  renderOverlay,
}: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [pageDimensions, setPageDimensions] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });

  const onDocumentLoadSuccess = useCallback(
    async (pdf: {
      numPages: number;
      getPage: (n: number) => Promise<{ view: number[] }>;
    }) => {
      setNumPages(pdf.numPages);
      try {
        const page = await pdf.getPage(1);
        const [, , w, h] = page.view;
        setPageDimensions({ width: w, height: h });
      } catch {
        // fallback
      }
    },
    []
  );

  // Track which page is most visible via IntersectionObserver
  useEffect(() => {
    if (!containerRef.current || numPages === 0 || !onVisiblePageChange) return;

    const visibleRatios = new Map<number, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number(
            (entry.target as HTMLElement).dataset.pageNumber
          );
          if (!isNaN(pageNum)) {
            visibleRatios.set(pageNum, entry.intersectionRatio);
          }
        }
        let bestPage = 1;
        let bestRatio = 0;
        for (const [page, ratio] of visibleRatios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = page;
          }
        }
        if (bestRatio > 0) {
          onVisiblePageChange(bestPage);
        }
      },
      {
        root: containerRef.current,
        threshold: [0, 0.25, 0.5, 0.75, 1],
      }
    );

    for (const [, el] of pageRefs.current) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [numPages, onVisiblePageChange]);

  // Highlight exact text in the text layer
  useEffect(() => {
    if (!containerRef.current) return;

    // Clear previous highlights
    const existingMarks =
      containerRef.current.querySelectorAll("mark[data-search-highlight]");
    for (const mark of existingMarks) {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(
          document.createTextNode(mark.textContent ?? ""),
          mark
        );
        parent.normalize();
      }
    }

    const query = highlightText?.trim().toLowerCase();
    if (!query || query.length < 2) return;

    // Walk all text layer spans across all rendered pages
    const textLayers =
      containerRef.current.querySelectorAll(".textLayer");

    for (const layer of textLayers) {
      const spans = layer.querySelectorAll("span");
      for (const span of spans) {
        highlightInNode(span, query);
      }
    }
  }, [highlightText, numPages]);

  const scrollToPage = useCallback((pageNumber: number) => {
    const el = pageRefs.current.get(pageNumber);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  useEffect(() => {
    if (containerRef.current) {
      (
        containerRef.current as HTMLDivElement & {
          scrollToPage?: (p: number) => void;
        }
      ).scrollToPage = scrollToPage;
    }
  }, [scrollToPage]);

  return (
    <div ref={containerRef} className="overflow-y-auto h-full">
      <Document
        file={url}
        onLoadSuccess={onDocumentLoadSuccess}
        loading={
          <div className="flex items-center justify-center h-96">
            <p className="text-muted-foreground">Loading PDF...</p>
          </div>
        }
      >
        <div className="flex flex-col items-center gap-4 py-4">
          {Array.from({ length: numPages }, (_, i) => i + 1).map(
            (pageNumber) => (
              <div
                key={pageNumber}
                ref={(el) => {
                  if (el) pageRefs.current.set(pageNumber, el);
                }}
                data-page-number={pageNumber}
                className="relative border rounded-lg bg-white shadow-sm"
              >
                <Page
                  pageNumber={pageNumber}
                  width={700}
                  renderAnnotationLayer={false}
                />
                {renderOverlay && pageDimensions.width > 0 && (
                  <div className="absolute inset-0 pointer-events-none z-10">
                    {renderOverlay(pageNumber, pageDimensions)}
                  </div>
                )}
                <div className="absolute bottom-2 right-3 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full z-20">
                  {pageNumber}
                </div>
              </div>
            )
          )}
        </div>
      </Document>
    </div>
  );
}

/**
 * Walk text nodes inside an element and wrap occurrences of `query`
 * with <mark> tags for visual highlighting.
 */
function highlightInNode(el: Element, query: string) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? "";
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx === -1) continue;

    // Split the text node: before | match | after
    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + query.length);
    const after = text.slice(idx + query.length);

    const parent = textNode.parentNode;
    if (!parent) continue;

    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));

    const mark = document.createElement("mark");
    mark.setAttribute("data-search-highlight", "true");
    mark.style.backgroundColor = "rgba(250, 204, 21, 0.5)";
    mark.style.color = "inherit";
    mark.style.padding = "0";
    mark.style.borderRadius = "1px";
    mark.textContent = match;
    frag.appendChild(mark);

    if (after) frag.appendChild(document.createTextNode(after));

    parent.replaceChild(frag, textNode);
  }
}

export type PdfViewerRef = {
  scrollToPage: (page: number) => void;
};

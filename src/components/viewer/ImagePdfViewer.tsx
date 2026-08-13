import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  buildPageTextTokens,
  separatorText,
  type PageTextToken,
  type TextBlock,
} from "../../lib/pdfTextGeometry";
import type { PageDims } from "./PersonHighlight";
import { usePdfDocument } from "../../lib/pdfDocument";
import { PdfPageCanvas } from "./PdfPageCanvas";

/**
 * Paged PDF viewer: each page is a rendered surface plus a transparent text
 * layer built from the stored line boxes, so text stays selectable, searchable
 * with the browser's own find, and highlightable by the block overlays.
 *
 * Pages are drawn in the browser by pdf.js from the original file. They used to
 * be PNGs rasterized ahead of time by convex/renderPages.ts, which meant no
 * page could be shown until a server job had finished the whole document — the
 * source of the "Preparing pages" wait, and of documents that stranded when
 * that job was killed. Those rasters were also ~2.1 MB per page against ~97 KB
 * of source PDF, and nothing on the server ever read them.
 *
 * What that design was buying, and what this one must therefore handle: no
 * worker to mismatch, and no render task to cancel mid-scroll. PdfPageCanvas
 * owns the cancellation; the shared document cache owns the worker.
 *
 * Scanned pages are unaffected either way — their text layer comes from OCR
 * blocks, not from the PDF.
 */

/** Rendered width of a page in CSS pixels. The block overlays scale their OCR
 * coordinates against this same constant (see PageOverlays). */
const PAGE_WIDTH = 700;

const PDF_TEXT_TOKEN_SELECTOR = "[data-pdf-text-token]";

interface MarqueeSelection {
  pageNumber: number;
  tokenIds: Set<string>;
  text: string;
}

interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Return a DOM boundary's character offset within one OCR line. */
function textOffsetWithin(
  line: HTMLElement,
  container: Node,
  offset: number
): number | null {
  if (container !== line && !line.contains(container)) return null;

  const prefix = line.ownerDocument.createRange();
  prefix.selectNodeContents(line);
  try {
    prefix.setEnd(container, offset);
  } catch {
    return null;
  }
  return prefix.toString().length;
}

/**
 * Serialize selected OCR lines explicitly instead of putting selectable <br>
 * nodes into the spatial text layer. Those breaks otherwise sit at x=0 and
 * produce a blue stripe whenever a native selection crosses multiple lines.
 */
function selectedPdfText(root: HTMLElement, selection: Selection): string | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const pieces: Array<{
    text: string;
    separatorBefore: PageTextToken["separatorBefore"];
  }> = [];
  for (const token of root.querySelectorAll<HTMLElement>(PDF_TEXT_TOKEN_SELECTOR)) {
    if (!selection.containsNode(token, true)) continue;

    const text = token.textContent ?? "";
    let start = 0;
    let end = text.length;

    const selectedStart = textOffsetWithin(
      token,
      range.startContainer,
      range.startOffset
    );
    if (selectedStart !== null) start = selectedStart;

    const selectedEnd = textOffsetWithin(
      token,
      range.endContainer,
      range.endOffset
    );
    if (selectedEnd !== null) end = selectedEnd;

    const piece = text.slice(start, end);
    if (!piece) continue;

    pieces.push({
      text: piece,
      separatorBefore:
        (token.dataset.separatorBefore as PageTextToken["separatorBefore"]) ??
        "space",
    });
  }

  if (pieces.length === 0) return null;

  let text = pieces[0].text;
  for (let index = 1; index < pieces.length; index++) {
    const current = pieces[index];
    text += separatorText(current.separatorBefore) + current.text;
  }

  return text;
}

function serializeTokens(tokens: PageTextToken[]): string {
  if (tokens.length === 0) return "";
  let text = tokens[0].text;
  for (let index = 1; index < tokens.length; index++) {
    text += separatorText(tokens[index].separatorBefore) + tokens[index].text;
  }
  return text;
}

export interface ImagePdfViewerRef {
  scrollToPage: (pageNumber: number) => void;
}

export interface PageImage {
  pageNumber: number; // 0-indexed
  width: number;
  height: number;
  url: string | null;
  rendererVersion?: number;
}

interface ImagePdfViewerProps {
  documentId: Id<"documents">;
  /**
   * URL of the original PDF. When present the pages are drawn client-side by
   * pdf.js and no server raster is needed; pageImages is only a fallback for
   * documents rendered before the server rasterizer was removed.
   */
  pdfUrl?: string | null;
  pageImages: PageImage[];
  /** OCR page dimensions — the coordinate space the text layer scales from. */
  pages: PageDims[];
  totalPages: number;
  documentRotation?: 0 | 90 | 180 | 270;
  onVisiblePageChange?: (pageNumber: number) => void;
  onRotatePage?: (pageNumber: number) => void;
  /** Overlay layer for a 1-indexed page (block boxes, entity highlights). */
  renderOverlay?: (pageNumber: number, renderedWidth: number) => React.ReactNode;
  ref?: Ref<ImagePdfViewerRef>;
}

export function ImagePdfViewer({
  documentId,
  pdfUrl,
  pageImages,
  pages,
  totalPages,
  documentRotation = 0,
  onVisiblePageChange,
  onRotatePage,
  renderOverlay,
  ref,
}: ImagePdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const { pdf, error: pdfError } = usePdfDocument(pdfUrl);
  const [nearPages, setNearPages] = useState<Set<number>>(new Set([1]));
  const [marqueeSelection, setMarqueeSelection] =
    useState<MarqueeSelection | null>(null);
  const imagesByPage = useMemo(() => {
    const map = new Map<number, PageImage>();
    for (const img of pageImages) map.set(img.pageNumber, img);
    return map;
  }, [pageImages]);

  const pageCount = Math.max(totalPages, pageImages.length, 1);

  // Fallback aspect ratio for pages whose image hasn't been rendered yet —
  // keeps the scroll height stable so nothing jumps when images arrive.
  const fallbackAspect = useMemo(() => {
    const withDims =
      pageImages.find((p) => p.width > 0) ??
      pages.find((p) => p.width && p.height);
    if (withDims && withDims.width && withDims.height) {
      return withDims.height / withDims.width;
    }
    return 11 / 8.5;
  }, [pageImages, pages]);

  // Not smooth: pages below the proximity window mount their text layers as
  // the animation crosses them, and the resulting reflow cancels the browser's
  // smooth scroll partway. A jump from page 5 to page 9 simply never arrived —
  // which read as "clicking the table of contents does nothing".
  const scrollToPage = useCallback((pageNumber: number) => {
    pageRefs.current.get(pageNumber)?.scrollIntoView({ block: "start" });
  }, []);

  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const selection = event.currentTarget.ownerDocument.defaultView?.getSelection();
    const text = selection
      ? selectedPdfText(event.currentTarget, selection) ?? marqueeSelection?.text
      : marqueeSelection?.text;
    if (!text) return;

    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
  }, [marqueeSelection]);

  // Which page is most visible (drives the TOC's current-page indicator), and
  // which pages are close enough to the viewport to deserve a text layer.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const ratios = new Map<number, number>();
    const visibility = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number(
            (entry.target as HTMLElement).dataset.pageNumber
          );
          if (!Number.isNaN(page)) ratios.set(page, entry.intersectionRatio);
        }
        let bestPage = 0;
        let bestRatio = 0;
        for (const [page, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = page;
          }
        }
        if (bestPage > 0) onVisiblePageChange?.(bestPage);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );

    // Generous margin so a page's text is selectable by the time it scrolls
    // into view, without mounting every page's blocks at once.
    const proximity = new IntersectionObserver(
      (entries) => {
        setNearPages((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const page = Number(
              (entry.target as HTMLElement).dataset.pageNumber
            );
            if (Number.isNaN(page)) continue;
            if (entry.isIntersecting && !next.has(page)) {
              next.add(page);
              changed = true;
            } else if (!entry.isIntersecting && next.has(page)) {
              next.delete(page);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root, rootMargin: "100% 0px", threshold: 0 }
    );

    for (const el of pageRefs.current.values()) {
      visibility.observe(el);
      proximity.observe(el);
    }
    return () => {
      visibility.disconnect();
      proximity.disconnect();
    };
  }, [pageCount, onVisiblePageChange]);

  return (
    <div
      ref={containerRef}
      className="overflow-y-auto h-full"
      onCopy={handleCopy}
    >
      <div className="flex flex-col items-center gap-4 py-4">
        {Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNumber) => {
          const image = imagesByPage.get(pageNumber - 1);
          const page = pages.find(
            (candidate) => candidate.pageNumber === pageNumber - 1
          );
          const sourceWidth = image?.width ?? page?.width ?? PAGE_WIDTH;
          const sourceHeight =
            image?.height ?? page?.height ?? PAGE_WIDTH * fallbackAspect;
          const rotation = ((
            documentRotation + (page?.viewerRotationAdjustment ?? 0)
          ) % 360) as 0 | 90 | 180 | 270;
          const sideways = rotation === 90 || rotation === 270;
          const fitScale =
            PAGE_WIDTH / (sideways ? sourceHeight : sourceWidth);
          // The surface stays in the source coordinate orientation. Rotating
          // this one element moves pixels, text, and every overlay together.
          const surfaceWidth = Math.round(sourceWidth * fitScale);
          const surfaceHeight = Math.round(sourceHeight * fitScale);
          const height = sideways ? surfaceWidth : surfaceHeight;
          const isNear = nearPages.has(pageNumber);

          return (
            <div
              key={pageNumber}
              ref={(el) => {
                if (el) pageRefs.current.set(pageNumber, el);
                else pageRefs.current.delete(pageNumber);
              }}
              data-page-number={pageNumber}
              className="relative border rounded-lg bg-white shadow-sm overflow-hidden"
              style={{ width: PAGE_WIDTH, height }}
            >
              <div
                className="absolute left-1/2 top-1/2"
                style={{
                  width: surfaceWidth,
                  height: surfaceHeight,
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                }}
              >
                {pdf && isNear ? (
                  <PdfPageCanvas
                    pdf={pdf}
                    pageNumber={pageNumber}
                    cssWidth={surfaceWidth}
                    cssHeight={surfaceHeight}
                  />
                ) : image?.url && isNear ? (
                  // Legacy path: documents rasterized before the renderer was
                  // removed, and anything without a fetchable original.
                  <img
                    src={image.url}
                    alt={`Page ${pageNumber}`}
                    width={surfaceWidth}
                    height={surfaceHeight}
                    loading={pageNumber === 1 ? "eager" : "lazy"}
                    fetchPriority={pageNumber === 1 ? "high" : "auto"}
                    decoding="async"
                    draggable={false}
                    className="block h-full w-full select-none"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-xs text-muted-foreground">
                      {pdfError
                        ? `Could not open the PDF: ${pdfError}`
                        : `Loading page ${pageNumber}…`}
                    </span>
                  </div>
                )}

                {isNear ? (
                  <PageTextLayer
                    documentId={documentId}
                    pageNumber={pageNumber}
                    pages={pages}
                    renderedWidth={surfaceWidth}
                    rotation={rotation}
                    marqueeSelection={
                      marqueeSelection?.pageNumber === pageNumber
                        ? marqueeSelection
                        : null
                    }
                    onMarqueeSelectionChange={setMarqueeSelection}
                  />
                ) : null}

                {isNear && renderOverlay && (
                  <div className="absolute inset-0 pointer-events-none z-10">
                    {renderOverlay(pageNumber, surfaceWidth)}
                  </div>
                )}
              </div>

              <div className="absolute bottom-2 right-3 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full z-20 pointer-events-none">
                {pageNumber}
              </div>
              {onRotatePage && (
                <button
                  type="button"
                  onClick={() => onRotatePage(pageNumber)}
                  className="absolute bottom-2 left-3 z-20 rounded-full bg-black/50 px-2 py-0.5 text-xs text-white hover:bg-black/70"
                  title={`Rotate page ${pageNumber} clockwise`}
                  aria-label={`Rotate page ${pageNumber} clockwise`}
                >
                  ↻
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Transparent, selectable text for one page, positioned from the OCR line
 * boxes. Each line is a single span so that copying yields real words with
 * spaces; the span is then stretched horizontally to match the measured line
 * box, which is how pdf.js keeps selection aligned with the drawn glyphs.
 */
function PageTextLayer({
  documentId,
  pageNumber,
  pages,
  renderedWidth,
  rotation,
  marqueeSelection,
  onMarqueeSelectionChange,
}: {
  documentId: Id<"documents">;
  pageNumber: number; // 1-indexed
  pages: PageDims[];
  renderedWidth: number;
  rotation: 0 | 90 | 180 | 270;
  marqueeSelection: MarqueeSelection | null;
  onMarqueeSelectionChange: (selection: MarqueeSelection | null) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const selectionSignatureRef = useRef("");
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<SelectionRect | null>(null);
  const [selectionBoxes, setSelectionBoxes] = useState<
    Array<{ id: string; left: number; top: number; width: number; height: number }>
  >([]);
  const blocks = useQuery(api.blocks.byDocumentPage, {
    documentId,
    pageNumber: pageNumber - 1,
  });

  const page = pages.find((candidate) => candidate.pageNumber === pageNumber - 1);
  const pageWidth = page?.width;
  const pageHeight = page?.height;
  const scale = pageWidth ? renderedWidth / pageWidth : 0;

  const tokens = useMemo(() => {
    if (!blocks || !scale || !pageWidth || !pageHeight) return [];
    return buildPageTextTokens(
      blocks as TextBlock[],
      pageWidth,
      pageHeight
    ).map((token) => ({
      ...token,
      left: token.bbox.x * scale,
      top: token.bbox.y * scale,
      width: token.bbox.width * scale,
      height: token.bbox.height * scale,
    }));
  }, [blocks, pageHeight, pageWidth, scale]);

  // Stretch each line to its OCR width. Runs again once webfonts settle,
  // since a font swap changes the measured width.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || tokens.length === 0) return;

    const fit = () => {
      for (const el of layer.querySelectorAll<HTMLElement>("span[data-w]")) {
        const target = Number(el.dataset.w);
        if (!target) continue;
        el.style.transform = "";
        const actual = el.getBoundingClientRect().width;
        if (actual > 0) {
          el.style.transform = `scaleX(${target / actual})`;
        }
      }
    };

    fit();
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) fit();
    });
    return () => {
      cancelled = true;
    };
  }, [tokens]);

  const localPoint = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      let x: number;
      let y: number;
      if (rotation === 90) {
        x = event.clientY - bounds.top;
        y = bounds.right - event.clientX;
      } else if (rotation === 180) {
        x = bounds.right - event.clientX;
        y = bounds.bottom - event.clientY;
      } else if (rotation === 270) {
        x = bounds.bottom - event.clientY;
        y = event.clientX - bounds.left;
      } else {
        x = event.clientX - bounds.left;
        y = event.clientY - bounds.top;
      }
      return {
        x: Math.max(0, Math.min(renderedWidth, x)),
        y: Math.max(0, Math.min(event.currentTarget.clientHeight, y)),
      };
    },
    [renderedWidth, rotation]
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest(PDF_TEXT_TOKEN_SELECTOR)) {
        if (marqueeSelection) onMarqueeSelectionChange(null);
        return;
      }

      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events and older embedded webviews may not expose capture;
        // mouse drags still complete while the pointer remains over the page.
      }
      const point = localPoint(event);
      dragOriginRef.current = point;
      setDragRect({ left: point.x, top: point.y, width: 0, height: 0 });
      onMarqueeSelectionChange(null);
    },
    [localPoint, marqueeSelection, onMarqueeSelectionChange]
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      event.preventDefault();
      const point = localPoint(event);
      setDragRect({
        left: Math.min(origin.x, point.x),
        top: Math.min(origin.y, point.y),
        width: Math.abs(point.x - origin.x),
        height: Math.abs(point.y - origin.y),
      });
    },
    [localPoint]
  );

  const finishMarquee = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      const point = localPoint(event);
      const rect = {
        left: Math.min(origin.x, point.x),
        top: Math.min(origin.y, point.y),
        width: Math.abs(point.x - origin.x),
        height: Math.abs(point.y - origin.y),
      };
      dragOriginRef.current = null;
      setDragRect(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (rect.width < 3 || rect.height < 3) {
        onMarqueeSelectionChange(null);
        return;
      }

      const selected = tokens.filter(
        (token) =>
          token.left < rect.left + rect.width &&
          token.left + token.width > rect.left &&
          token.top < rect.top + rect.height &&
          token.top + token.height > rect.top
      );
      if (selected.length === 0) {
        onMarqueeSelectionChange(null);
        return;
      }
      onMarqueeSelectionChange({
        pageNumber,
        tokenIds: new Set(selected.map((token) => token.id)),
        text: serializeTokens(selected),
      });
    },
    [localPoint, onMarqueeSelectionChange, pageNumber, tokens]
  );

  // The browser owns caret/range semantics; the visible selection is drawn
  // from validated token geometry so corrupt/off-page DOM boxes cannot leak
  // into the highlight. Boundary words are clipped to the selected characters.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const ownerDocument = layer.ownerDocument;
    const updateSelection = () => {
      const selection = ownerDocument.defaultView?.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        if (selectionSignatureRef.current) {
          selectionSignatureRef.current = "";
          setSelectionBoxes([]);
        }
        return;
      }

      const range = selection.getRangeAt(0);
      const tokenById = new Map(tokens.map((token) => [token.id, token]));
      const next = Array.from(
        layer.querySelectorAll<HTMLElement>(PDF_TEXT_TOKEN_SELECTOR)
      ).flatMap((element) => {
        const token = tokenById.get(element.dataset.pdfTextToken ?? "");
        if (!token || !selection.containsNode(element, true)) return [];

        const length = Math.max(1, element.textContent?.length ?? 0);
        const selectedStart = textOffsetWithin(
          element,
          range.startContainer,
          range.startOffset
        );
        const selectedEnd = textOffsetWithin(
          element,
          range.endContainer,
          range.endOffset
        );
        const start = Math.max(0, Math.min(length, selectedStart ?? 0));
        const end = Math.max(start, Math.min(length, selectedEnd ?? length));
        if (end <= start) return [];
        const left = token.left + token.width * (start / length);
        return [{
          id: token.id,
          left,
          top: token.top,
          width: token.width * ((end - start) / length),
          height: token.height,
        }];
      });
      const signature = next
        .map((box) => `${box.id}:${box.left}:${box.width}`)
        .join("|");
      if (signature !== selectionSignatureRef.current) {
        selectionSignatureRef.current = signature;
        setSelectionBoxes(next);
      }
    };

    ownerDocument.addEventListener("selectionchange", updateSelection);
    return () => ownerDocument.removeEventListener("selectionchange", updateSelection);
  }, [tokens]);

  if (tokens.length === 0) return null;

  return (
    <div
      ref={layerRef}
      className="pdf-text-layer absolute inset-0 z-[5]"
      style={{ lineHeight: 1, cursor: "pointer" }}
      tabIndex={0}
      aria-label={`Selectable text for page ${pageNumber}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishMarquee}
      onPointerCancel={finishMarquee}
    >
      {[
        ...selectionBoxes,
        ...tokens
          .filter((token) => marqueeSelection?.tokenIds.has(token.id))
          .map((token) => ({
            id: `marquee:${token.id}`,
            left: token.left,
            top: token.top,
            width: token.width,
            height: token.height,
          })),
      ].map((box) => (
        <span
          key={`selection:${box.id}`}
          aria-hidden="true"
          className="absolute pointer-events-none rounded-[2px] bg-blue-400/35"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
          }}
        />
      ))}
      {dragRect && (
        <span
          aria-hidden="true"
          className="absolute z-[3] border border-blue-500 bg-blue-400/15 pointer-events-none"
          style={dragRect}
        />
      )}
      {tokens.map((token) => (
        <span
          key={token.id}
          data-pdf-text-token={token.id}
          data-separator-before={token.separatorBefore}
          data-w={token.width}
          style={{
            position: "absolute",
            zIndex: 1,
            left: token.left,
            top: token.top,
            fontSize: token.height,
            fontFamily: "sans-serif",
            lineHeight: 1,
            whiteSpace: "pre",
            transformOrigin: "0 0",
            color: "transparent",
            cursor: "text",
          }}
        >
          {token.text}
        </span>
      ))}
    </div>
  );
}

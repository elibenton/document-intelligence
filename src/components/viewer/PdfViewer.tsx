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
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  buildPageTextTokens,
  separatorText,
  type PageTextToken,
  type TextBlock,
  type TextBox,
} from "../../lib/pdfTextGeometry";
import type { PageDims } from "./PersonHighlight";
import { usePdfDocument } from "../../lib/pdfDocument";
import { PdfPageCanvas } from "./PdfPageCanvas";
import {
  AnnotationComment,
  AnnotationLayer,
  HighlightActions,
  type SelectionAnchor,
  type ViewerAnnotation,
} from "./AnnotationLayer";
import { SelectionActions } from "./SelectionActions";
import {
  DEFAULT_ANNOTATION_COLOR,
  type AnnotationColor,
} from "./annotationColors";
import { mergeSelectionRects } from "./annotationGeometry";
import { useHighlightUndo } from "./useHighlightUndo";

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

/** The block overlays scale their OCR coordinates against the width they are
 * handed, not against PAGE_WIDTH (see PageOverlays), so zooming carries them
 * along. */
import { PAGE_WIDTH } from "./zoom";
import { PdfPageSkeleton } from "./PdfPageSkeleton";

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

/** A page's token with its box resolved into rendered pixels. */
interface ScaledToken extends PageTextToken {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One selected token, in both coordinate spaces the page cares about. */
interface SelectedSpan {
  id: string;
  blockId: string;
  /** Rendered pixels — what the live selection is drawn in. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Page units — what a highlight is *stored* in, so it survives zoom. */
  pageRect: TextBox;
}

/**
 * The tokens a native selection covers, clipped to the selected characters.
 *
 * The browser owns caret/range semantics; the boxes are then rebuilt from
 * validated token geometry rather than read off the DOM, so a corrupt or
 * off-page client rect cannot leak into either the visible selection or a
 * saved highlight. Boundary tokens are clipped proportionally — good enough
 * for a proportional-width span that has already been scaleX'd to its OCR box.
 */
function selectedSpans(
  layer: HTMLElement,
  tokens: ScaledToken[],
  selection: Selection
): SelectedSpan[] {
  if (selection.rangeCount === 0 || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  const tokenById = new Map(tokens.map((token) => [token.id, token]));

  return Array.from(
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

    const fraction = (end - start) / length;
    return [
      {
        id: token.id,
        blockId: token.blockId,
        left: token.left + token.width * (start / length),
        top: token.top,
        width: token.width * fraction,
        height: token.height,
        pageRect: {
          x: token.bbox.x + token.bbox.width * (start / length),
          y: token.bbox.y,
          width: token.bbox.width * fraction,
          height: token.bbox.height,
        },
      },
    ];
  });
}

/** A finished text selection — not yet a highlight; see SelectionActions. */
interface HighlightSelection {
  pageNumber: number; // 1-indexed, as the viewer counts pages
  text: string;
  /** Page units. */
  rects: TextBox[];
  blockIds: string[];
  /**
   * Existing highlights this selection overlaps. When set, text/rects/blockIds
   * are already the union, and the commit folds into the first id instead of
   * creating a second highlight over the same words.
   */
  mergeWith?: string[];
  /** Viewport box the offer popover hangs off. */
  anchor: SelectionAnchor;
}

/**
 * Which highlight has a popover open, and which one: the small add-note/delete
 * offer (`note: false`), or the full comment card (`note: true`).
 */
export interface ActiveAnnotation {
  id: string;
  note: boolean;
}

/** Strict overlap — merely touching boxes don't count as the same highlight. */
function rectsIntersect(a: TextBox, b: TextBox): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function uniqueBlockIds(spans: Array<{ blockId: string }>): string[] {
  return [...new Set(spans.map((span) => span.blockId))];
}

export interface PdfViewerRef {
  scrollToPage: (pageNumber: number) => void;
}

interface PdfViewerProps {
  documentId: Id<"documents">;
  /** URL of the original PDF. Pages are drawn client-side by pdf.js from it. */
  pdfUrl?: string | null;
  /** OCR page dimensions — the coordinate space the text layer scales from. */
  pages: PageDims[];
  totalPages: number;
  /** Page-width multiplier: 1 renders a page at PAGE_WIDTH CSS pixels. */
  zoom?: number;
  documentRotation?: 0 | 90 | 180 | 270;
  onVisiblePageChange?: (pageNumber: number) => void;
  /** Overlay layer for a 1-indexed page (block boxes, entity highlights). */
  renderOverlay?: (pageNumber: number, renderedWidth: number) => React.ReactNode;
  /**
   * The section a 0-indexed page sits under, stamped onto new highlights so a
   * note keeps the heading the user saw it under. See the schema comment on
   * `annotations.sectionTitle`.
   */
  sectionTitleForPage?: (pageNumber: number) => string | undefined;
  /** The highlight with a popover open. Shared with the notes panel. */
  activeAnnotation?: ActiveAnnotation | null;
  onActiveAnnotationChange?: (next: ActiveAnnotation | null) => void;
  /**
   * The armed highlighter color (HighlighterTool). While set, a selection
   * commits as a highlight of this color with no comment card afterwards.
   */
  penColor?: AnnotationColor | null;
  ref?: Ref<PdfViewerRef>;
}

export function PdfViewer({
  documentId,
  pdfUrl,
  pages,
  totalPages,
  zoom = 1,
  documentRotation = 0,
  onVisiblePageChange,
  renderOverlay,
  sectionTitleForPage,
  activeAnnotation: activeState = null,
  onActiveAnnotationChange,
  penColor = null,
  ref,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const { pdf, error: pdfError } = usePdfDocument(pdfUrl);
  const [nearPages, setNearPages] = useState<Set<number>>(new Set([1]));
  const [marqueeSelection, setMarqueeSelection] =
    useState<MarqueeSelection | null>(null);
  /** The selection an offer popover is up for. Not yet a highlight. */
  const [draft, setDraft] = useState<HighlightSelection | null>(null);

  // One document-wide subscription rather than one per mounted page: the rows
  // are small, and the notes panel needs all of them anyway.
  const annotations = useQuery(api.annotations.byDocument, { documentId });
  const createAnnotation = useMutation(api.annotations.create);
  const updateAnnotation = useMutation(api.annotations.update);
  const removeAnnotation = useMutation(api.annotations.remove);

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, ViewerAnnotation[]>();
    for (const annotation of annotations ?? []) {
      const list = map.get(annotation.pageNumber);
      if (list) list.push(annotation);
      else map.set(annotation.pageNumber, [annotation]);
    }
    return map;
  }, [annotations]);

  const activeAnnotation =
    annotations?.find((a) => a._id === activeState?.id) ?? null;

  // A click on a highlight opens the small actions offer, not the full card —
  // and retires any selection offer still up from a previous drag.
  const handleActivate = useCallback(
    (id: string | null) => {
      setDraft(null);
      onActiveAnnotationChange?.(id ? { id, note: false } : null);
    },
    [onActiveAnnotationChange]
  );

  // ⌘Z deletes the last highlight this visit created. The catch swallows the
  // not-found error for one already deleted through its comment card.
  const undoRemove = useCallback(
    (id: string) => {
      removeAnnotation({ id: id as Id<"annotations"> }).catch(() => {});
    },
    [removeAnnotation]
  );
  const recordCreated = useHighlightUndo(undoRemove);

  // A selection is committed only on request: the armed pen commits the
  // moment the drag lifts, and otherwise the drag opens the SelectionActions
  // offer, whose Highlight / Add note buttons call this. Overlapping an
  // existing highlight folds into it instead of stacking a second stripe.
  const mergeAnnotations = useMutation(api.annotations.merge);
  const commitSelection = useCallback(
    async (selection: HighlightSelection, color: AnnotationColor) => {
      if (selection.mergeWith?.length) {
        return await mergeAnnotations({
          id: selection.mergeWith[0] as Id<"annotations">,
          absorb: selection.mergeWith.slice(1) as Id<"annotations">[],
          text: selection.text,
          rects: selection.rects,
          blockIds: selection.blockIds,
        });
      }
      const id = await createAnnotation({
        documentId,
        pageNumber: selection.pageNumber - 1,
        color,
        text: selection.text,
        sectionTitle: sectionTitleForPage?.(selection.pageNumber - 1),
        rects: selection.rects,
        blockIds: selection.blockIds,
      });
      // Only fresh highlights join the ⌘Z stack: undoing a merge would
      // delete the survivor outright, losing the pre-merge highlight too.
      recordCreated(id);
      return id;
    },
    [
      createAnnotation,
      documentId,
      mergeAnnotations,
      recordCreated,
      sectionTitleForPage,
    ]
  );

  const handleSelection = useCallback(
    (selection: HighlightSelection) => {
      onActiveAnnotationChange?.(null);
      if (penColor) {
        setDraft(null);
        void commitSelection(selection, penColor);
        return;
      }
      setDraft(selection);
    },
    [commitSelection, onActiveAnnotationChange, penColor]
  );

  const settleDraft = useCallback(() => {
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const highlightDraft = useCallback(
    (openNote: boolean) => {
      if (!draft) return;
      settleDraft();
      void (async () => {
        const id = await commitSelection(draft, DEFAULT_ANNOTATION_COLOR);
        if (openNote) onActiveAnnotationChange?.({ id, note: true });
      })();
    },
    [commitSelection, draft, onActiveAnnotationChange, settleDraft]
  );

  // The deep-link format DocumentPage already understands: scroll to the page
  // and arm the text as a search highlight. The text is capped because it
  // rides in a URL; the clipboard keeps the full quote.
  const copyDraftLink = useCallback(() => {
    if (!draft) return;
    const url = new URL(window.location.pathname, window.location.origin);
    url.searchParams.set("page", String(draft.pageNumber));
    url.searchParams.set("highlight", draft.text.slice(0, 200));
    void navigator.clipboard.writeText(`“${draft.text}”\n${url.href}`);
    settleDraft();
  }, [draft, settleDraft]);

  const pageCount = Math.max(totalPages, 1);

  /**
   * Page geometry as pdf.js reports it — the authority on how tall a page is.
   *
   * The stored `pages` dimensions come from OCR, and OCR has been observed to
   * report a height its own coordinates contradict: a 12-page ABC application
   * arrived as 1224x3168 for pages that are really 612x792, so every page was
   * laid out in a box twice as tall as the paper. pdf.js painted the true page
   * into it stretched 2:1, and the text layer — scaled uniformly from the OCR
   * *width*, which was right — landed in the top half, which is why selecting
   * a page washed it blue.
   *
   * So the two are separated here: OCR dimensions stay the coordinate space
   * blocks are scaled from (PageTextLayer), and the surface is sized from the
   * PDF, which is also what PdfPageCanvas paints. Pixels and boxes are then
   * derived from the same geometry and cannot drift apart.
   */
  const [pdfPageSizes, setPdfPageSizes] = useState<
    Map<number, { width: number; height: number }>
  >(new Map());

  // Measurements belong to the document that produced them, so a new `pdf`
  // clears them. Done during render rather than in an effect: an effect would
  // let one paint happen against the old document's geometry before the reset
  // landed, which is the stretched-page bug above in miniature.
  const [seenPdf, setSeenPdf] = useState(pdf);
  if (pdf !== seenPdf) {
    setSeenPdf(pdf);
    setPdfPageSizes(new Map());
  }

  const handlePageSize = useCallback(
    (pageNumber: number, size: { width: number; height: number }) => {
      setPdfPageSizes((prev) => {
        const known = prev.get(pageNumber);
        if (known?.width === size.width && known.height === size.height) {
          return prev;
        }
        return new Map(prev).set(pageNumber, size);
      });
    },
    []
  );

  // Pages below the proximity window have no canvas yet, so they borrow the
  // first measured page's shape — near enough for a scroll height that does
  // not jump, and corrected the moment the page draws itself.
  const measuredPageSize =
    pdfPageSizes.get(1) ?? pdfPageSizes.values().next().value;

  // Last resort, for a document pdf.js has not opened at all.
  const fallbackAspect = useMemo(() => {
    const withDims = pages.find((p) => p.width && p.height);
    if (withDims && withDims.width && withDims.height) {
      return withDims.height / withDims.width;
    }
    return 11 / 8.5;
  }, [pages]);

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

  // Zoomed past the viewport, pages need somewhere to go: `min-w-max` on the
  // column lets the container scroll horizontally instead of clipping them.
  const renderWidth = Math.round(PAGE_WIDTH * zoom);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-auto"
      onCopy={handleCopy}
    >
      <div className="flex min-w-max flex-col items-center gap-4 px-4 py-4">
        {Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNumber) => {
          const page = pages.find(
            (candidate) => candidate.pageNumber === pageNumber - 1
          );
          const pdfSize = pdfPageSizes.get(pageNumber) ?? measuredPageSize;
          const sourceWidth = pdfSize?.width ?? page?.width ?? PAGE_WIDTH;
          const sourceHeight =
            pdfSize?.height ?? page?.height ?? PAGE_WIDTH * fallbackAspect;
          const rotation = ((
            documentRotation + (page?.viewerRotationAdjustment ?? 0)
          ) % 360) as 0 | 90 | 180 | 270;
          const sideways = rotation === 90 || rotation === 270;
          const fitScale =
            renderWidth / (sideways ? sourceHeight : sourceWidth);
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
              // Square corners and a light shadow, deliberately: the page is
              // paper, not another floating panel (see surfaces.ts).
              className="relative shrink-0 border bg-white shadow-sm overflow-hidden"
              style={{ width: renderWidth, height }}
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
                    onPageSize={handlePageSize}
                  />
                ) : pdfError ? (
                  <div className="absolute inset-0 flex items-center justify-center p-6">
                    <span className="text-center text-xs text-muted-foreground">
                      Could not open the PDF: {pdfError}
                    </span>
                  </div>
                ) : (
                  <PdfPageSkeleton
                    pageNumber={pageNumber}
                    label={`Loading page ${pageNumber}`}
                  />
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
                    annotations={annotationsByPage.get(pageNumber - 1) ?? []}
                    activeAnnotationId={activeState?.id ?? null}
                    onActivateAnnotation={handleActivate}
                    onSelect={handleSelection}
                  />
                ) : null}

                {isNear && renderOverlay && (
                  <div className="absolute inset-0 pointer-events-none z-10">
                    {renderOverlay(pageNumber, surfaceWidth)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Portalled out, so they escape the page surface's zoom and rotation. */}
      {draft && (
        <SelectionActions
          anchor={draft.anchor}
          onHighlight={() => highlightDraft(false)}
          onNote={() => highlightDraft(true)}
          onCopyLink={copyDraftLink}
          onDismiss={() => setDraft(null)}
        />
      )}
      {activeAnnotation && !activeState?.note && (
        <HighlightActions
          key={activeAnnotation._id}
          annotation={activeAnnotation}
          onNote={() =>
            onActiveAnnotationChange?.({ id: activeAnnotation._id, note: true })
          }
          onDelete={() => {
            void removeAnnotation({
              id: activeAnnotation._id as Id<"annotations">,
            });
            onActiveAnnotationChange?.(null);
          }}
          onDismiss={() => onActiveAnnotationChange?.(null)}
        />
      )}
      {activeAnnotation && activeState?.note && (
        <AnnotationComment
          // Remount per highlight: the comment draft is seeded from the row.
          key={activeAnnotation._id}
          annotation={activeAnnotation}
          onChangeComment={(comment) => {
            void updateAnnotation({ id: activeAnnotation._id as Id<"annotations">, comment });
            onActiveAnnotationChange?.(null);
          }}
          onChangeColor={(color) =>
            void updateAnnotation({
              id: activeAnnotation._id as Id<"annotations">,
              color,
            })
          }
          onDelete={() => {
            void removeAnnotation({
              id: activeAnnotation._id as Id<"annotations">,
            });
            onActiveAnnotationChange?.(null);
          }}
          onDismiss={() => onActiveAnnotationChange?.(null)}
        />
      )}
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
  annotations,
  activeAnnotationId,
  onActivateAnnotation,
  onSelect,
}: {
  documentId: Id<"documents">;
  pageNumber: number; // 1-indexed
  pages: PageDims[];
  renderedWidth: number;
  rotation: 0 | 90 | 180 | 270;
  marqueeSelection: MarqueeSelection | null;
  onMarqueeSelectionChange: (selection: MarqueeSelection | null) => void;
  annotations: ViewerAnnotation[];
  activeAnnotationId: string | null;
  onActivateAnnotation: (id: string | null) => void;
  onSelect: (selection: HighlightSelection) => void;
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

    // Three passes, not one. Interleaving a style write with a
    // getBoundingClientRect read forces a synchronous layout *per token* — a
    // 1,500-word page paid ~1,500 forced reflows, twice (once immediately,
    // once after fonts load). Batching the writes and reads apart costs two
    // layouts total.
    const fit = () => {
      const els = Array.from(
        layer.querySelectorAll<HTMLElement>("span[data-w]")
      ).filter((el) => Number(el.dataset.w));

      for (const el of els) el.style.transform = "";
      const widths = els.map((el) => el.getBoundingClientRect().width);
      els.forEach((el, i) => {
        const target = Number(el.dataset.w);
        if (widths[i] > 0) {
          el.style.transform = `scaleX(${target / widths[i]})`;
        }
      });
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

  /**
   * The union of a selection with any existing highlights it overlaps, or
   * null when it touches none. Overlap works at token granularity: the
   * covered set is every token the selection or an overlapped highlight
   * reaches, re-serialized in reading order — so a drag across the edge of
   * a highlight grows it instead of stacking a second stripe on top.
   */
  const overlapUnion = useCallback(
    (selectedIds: Set<string>) => {
      const selectedBoxes = tokens.filter((token) => selectedIds.has(token.id));
      const overlapped = annotations.filter((annotation) =>
        annotation.rects.some((rect) =>
          selectedBoxes.some((token) => rectsIntersect(rect, token.bbox))
        )
      );
      if (overlapped.length === 0) return null;
      const covered = tokens.filter(
        (token) =>
          selectedIds.has(token.id) ||
          overlapped.some((annotation) =>
            annotation.rects.some((rect) => rectsIntersect(rect, token.bbox))
          )
      );
      return {
        text: serializeTokens(covered),
        rects: mergeSelectionRects(covered.map((token) => token.bbox)),
        blockIds: uniqueBlockIds(covered),
        mergeWith: overlapped.map((annotation) => annotation._id),
      };
    },
    [annotations, tokens]
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
        // A click on bare page, not a drag: dismiss whatever was open.
        onMarqueeSelectionChange(null);
        onActivateAnnotation(null);
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
        // Dragged across bare page — the same dismissal a click gets.
        onMarqueeSelectionChange(null);
        onActivateAnnotation(null);
        return;
      }
      const text = serializeTokens(selected);
      onMarqueeSelectionChange({
        pageNumber,
        tokenIds: new Set(selected.map((token) => token.id)),
        text,
      });
      // A marquee is a text selection too, so it gets the same offer. Its
      // anchor is the pointer rather than a range rect: the marquee's own box
      // is in the page's rotated local space, and turning that back into
      // viewport pixels would re-derive the transform by hand.
      const anchor = {
        left: event.clientX,
        right: event.clientX,
        top: event.clientY,
        bottom: event.clientY,
      };
      const union = overlapUnion(new Set(selected.map((token) => token.id)));
      onSelect(
        union
          ? { pageNumber, anchor, ...union }
          : {
              pageNumber,
              anchor,
              text,
              rects: mergeSelectionRects(selected.map((token) => token.bbox)),
              blockIds: uniqueBlockIds(selected),
            }
      );
    },
    [
      localPoint,
      onActivateAnnotation,
      onSelect,
      onMarqueeSelectionChange,
      overlapUnion,
      pageNumber,
      tokens,
    ]
  );

  // The live blue selection, redrawn from validated token geometry as the
  // browser's range moves. See selectedSpans for why the DOM's own rects are
  // not trusted here.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const ownerDocument = layer.ownerDocument;
    const updateSelection = () => {
      const selection = ownerDocument.defaultView?.getSelection();
      const next = selection ? selectedSpans(layer, tokens, selection) : [];
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

  /**
   * Mouse-up over a live text selection: commit it as a highlight.
   *
   * A selection dragged across a page boundary only yields the part that lives
   * on the page the pointer came up over — each page owns its own text layer
   * and its own coordinate space, and one row cannot span two of them.
   */
  const captureSelection = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return false;
    const selection = layer.ownerDocument.defaultView?.getSelection();
    if (!selection) return false;
    const spans = selectedSpans(layer, tokens, selection);
    if (spans.length === 0) return false;
    const text = selectedPdfText(layer, selection);
    if (!text?.trim()) return false;

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const anchor = {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    };
    // On overlap the union wins — including its whole-token boundaries, which
    // beat keeping a partial word once two drags cover the same stretch.
    const union = overlapUnion(new Set(spans.map((span) => span.id)));
    onSelect(
      union
        ? { pageNumber, anchor, ...union }
        : {
            pageNumber,
            anchor,
            text,
            rects: mergeSelectionRects(spans.map((span) => span.pageRect)),
            blockIds: uniqueBlockIds(spans),
          }
    );
    return true;
  }, [onSelect, overlapUnion, pageNumber, tokens]);

  /** The highlight under a point, in page units. Topmost (newest) wins. */
  const annotationAt = useCallback(
    (point: { x: number; y: number }) => {
      if (!scale) return null;
      const x = point.x / scale;
      const y = point.y / scale;
      for (let index = annotations.length - 1; index >= 0; index--) {
        const annotation = annotations[index];
        const hit = annotation.rects.some(
          (rect) =>
            x >= rect.x &&
            x <= rect.x + rect.width &&
            y >= rect.y &&
            y <= rect.y + rect.height
        );
        if (hit) return annotation;
      }
      return null;
    },
    [annotations, scale]
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragOriginRef.current) {
        finishMarquee(event);
        return;
      }
      if (captureSelection()) return;
      // A plain click, with nothing selected: open the highlight under it, or
      // dismiss whatever was open.
      const hit = annotationAt(localPoint(event));
      onActivateAnnotation(hit ? hit._id : null);
    },
    [
      annotationAt,
      captureSelection,
      finishMarquee,
      localPoint,
      onActivateAnnotation,
    ]
  );

  // No text geometry yet (or none at all) — saved highlights still draw, since
  // their anchor is page geometry rather than anything in the text layer.
  if (tokens.length === 0) {
    return (
      <AnnotationLayer
        annotations={annotations}
        scale={scale}
        activeId={activeAnnotationId}
      />
    );
  }

  return (
    <>
      <AnnotationLayer
        annotations={annotations}
        scale={scale}
        activeId={activeAnnotationId}
      />
      <div
        ref={layerRef}
        className="pdf-text-layer absolute inset-0 z-[5]"
        style={{ lineHeight: 1, cursor: "pointer" }}
        tabIndex={0}
        aria-label={`Selectable text for page ${pageNumber}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={finishMarquee}
      >
      {/* Per-token boxes merged into line runs before drawing: five selected
          words paint as one stripe, not five slabs with hairlines between. */}
      {mergeSelectionRects(
        [
          ...selectionBoxes,
          ...tokens
            .filter((token) => marqueeSelection?.tokenIds.has(token.id))
            .map((token) => ({
              left: token.left,
              top: token.top,
              width: token.width,
              height: token.height,
            })),
        ].map((box) => ({
          x: box.left,
          y: box.top,
          width: box.width,
          height: box.height,
        }))
      ).map((run, index) => (
        <span
          key={`selection:${index}:${run.x}:${run.y}`}
          aria-hidden="true"
          className="absolute pointer-events-none rounded-[2px] bg-blue-400/35"
          style={{
            left: run.x,
            top: run.y,
            width: run.width,
            height: run.height,
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
      {/* Highlighted stretches are click targets, not text: clicking anywhere
          inside one selects the highlight (its actions popover) instead of
          dropping a caret into the middle of it, and the cursor says so. A
          selection that needs to cross a highlight starts outside it and
          merges in. */}
      {scale > 0 &&
        annotations.map((annotation) =>
          mergeSelectionRects(annotation.rects).map((rect, index) => (
            <span
              key={`${annotation._id}:${index}`}
              aria-hidden="true"
              className="absolute z-[6] cursor-pointer"
              style={{
                left: rect.x * scale,
                top: rect.y * scale,
                width: rect.width * scale,
                height: rect.height * scale,
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerUp={(event) => {
                event.stopPropagation();
                onActivateAnnotation(annotation._id);
              }}
            />
          ))
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
    </>
  );
}

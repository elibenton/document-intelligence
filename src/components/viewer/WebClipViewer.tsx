import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/spinner";
import {
  AnnotationComment,
  HighlightActions,
  type SelectionAnchor,
} from "./AnnotationLayer";
import type { ActiveAnnotation } from "./PdfViewer";
import { SelectionActions } from "./SelectionActions";
import {
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_COLOR,
  type AnnotationColor,
} from "./annotationColors";
import { useHighlightUndo } from "./useHighlightUndo";
import { smoothScrollIntoView } from "@/lib/smoothScroll";
import {
  buildTextIndex,
  quoteFromRange,
  rangeFromQuote,
  type QuoteAnchor,
  type TextIndex,
} from "./webClipAnchoring";

interface WebClipViewerProps {
  documentId: Id<"documents">;
  url: string; // storage URL of the archived single-file HTML snapshot
  /** Storage URL of the clip's parsed article markdown — the text fallback. */
  textUrl?: string | null;
  /** "archive" renders the snapshot; "text" renders the parsed article
   *  markdown — the escape hatch when the archive itself is unusable. */
  view?: "archive" | "text";
  /** Armed highlighter color: a selection commits straight to a highlight
   *  on pointer-up, skipping the offer popover. */
  penColor?: AnnotationColor | null;
  activeAnnotation?: ActiveAnnotation | null;
  onActiveAnnotationChange?: (next: ActiveAnnotation | null) => void;
}

// Not every stored blob is a styled single-file archive: older clippers
// saved bare Readability output with no CSS at all, which renders as
// unformatted text and natural-size images. Those get reader typography;
// real archives keep their own styles untouched.
const hasOwnStyles = (html: string): boolean =>
  /<style[\s>]|rel=["']?stylesheet/i.test(html);

const READER_HEAD = `<base target="_blank"><style>
  body { margin: 2rem auto; padding: 0 1.5rem; max-width: 42rem;
    font: 17px/1.65 Georgia, "Times New Roman", serif; color: #1a1a1a;
    background: #fff; overflow-wrap: break-word; }
  img, video { max-width: 100%; height: auto; }
  figure { margin: 1.5rem 0; }
  figcaption { font-size: 0.85em; color: #666; }
  h1, h2, h3, h4 { line-height: 1.25; font-family: system-ui, sans-serif; }
  a { color: #1a56db; }
  blockquote { margin: 1.5rem 0; padding-left: 1rem;
    border-left: 3px solid #ddd; color: #555; }
  pre { overflow-x: auto; }
  table { display: block; overflow-x: auto; border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; }
</style>`;

function withReaderStyles(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  const at = head ? head.index + head[0].length : 0;
  return html.slice(0, at) + READER_HEAD + html.slice(at);
}

/** ::highlight rules for the five marker colors, injected into the archive.
 *  The active highlight adds an underline — ::highlight can't draw a ring. */
const HIGHLIGHT_CSS =
  ANNOTATION_COLORS.map(
    (c) => `::highlight(haystack-${c.key}) { background-color: ${c.fill}; }`
  ).join("\n") +
  "\n::highlight(haystack-active) { text-decoration: underline 2px; }";

/** A drag's selection, awaiting the offer popover's verdict. */
interface PendingNote {
  anchor: SelectionAnchor;
  quote: QuoteAnchor;
}

/**
 * Archived pages often ship a modal captured mid-display — a subscribe
 * prompt, a cookie wall — and with scripts stripped, its close button is
 * dead. Remove modal roles and fixed overlays covering a meaningful share of
 * the viewport, then undo the scroll lock they installed. Small fixed chrome
 * (a site header, a bottom banner) is under the coverage bar and stays.
 */
function removeArchivedOverlays(doc: Document, win: Window): void {
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  if (!vw || !vh) return;
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("*"))) {
    if (!el.isConnected) continue; // inside an overlay already removed
    const isModal = el.matches("dialog[open], [aria-modal='true']");
    if (!isModal && win.getComputedStyle(el).position !== "fixed") continue;
    const rect = el.getBoundingClientRect();
    const coverage =
      (Math.min(rect.width, vw) * Math.min(rect.height, vh)) / (vw * vh);
    if (isModal || coverage >= 0.25) el.remove();
  }
  for (const el of [doc.documentElement, doc.body]) {
    const { overflow, overflowY } = win.getComputedStyle(el);
    if (overflow === "hidden" || overflowY === "hidden") {
      el.style.setProperty("overflow", "visible", "important");
    }
  }
}

export function WebClipViewer({
  documentId,
  url,
  textUrl = null,
  view = "archive",
  penColor = null,
  activeAnnotation = null,
  onActiveAnnotationChange,
}: WebClipViewerProps) {
  const [state, setState] = useState<
    { html: string } | { error: string } | null
  >(null);

  // The text fallback's markdown, fetched lazily by the effect below.
  const [textState, setTextState] = useState<
    { markdown: string } | { error: string } | null
  >(null);

  // Reset for a new document during render, not in the effect — the effect
  // only starts the fetch.
  const [seenUrl, setSeenUrl] = useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    setState(null);
    setTextState(null);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        return response.text();
      })
      .then((html) => {
        setState({ html: hasOwnStyles(html) ? html : withReaderStyles(html) });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setState({ error: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [url]);

  // ---------------------------------------------------------------------
  // Highlights and notes. The archive renders in a same-origin sandboxed
  // iframe — scripts stay blocked (no allow-scripts; capture strips them
  // too), and same-origin is what lets this component read selections and
  // paint highlights inside it. Highlights anchor by text quote and draw
  // through the CSS Custom Highlight API, so the archive's DOM is never
  // rewritten and reflow can't strand a stripe.
  // ---------------------------------------------------------------------

  const annotations = useQuery(api.annotations.byDocument, { documentId });
  const createAnnotation = useMutation(api.annotations.create);
  const updateAnnotation = useMutation(api.annotations.update);
  const removeAnnotation = useMutation(api.annotations.remove);
  const undoRemove = useCallback(
    (id: string) => {
      removeAnnotation({ id: id as Id<"annotations"> }).catch(() => {});
    },
    [removeAnnotation]
  );
  const recordCreated = useHighlightUndo(undoRemove);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Bumped when the iframe (re)loads; every DOM-touching effect keys off it.
  const [frameGen, setFrameGen] = useState(0);
  // Bumped on iframe scroll/resize so popover anchors re-measure and follow.
  const [anchorVersion, setAnchorVersion] = useState(0);
  const indexRef = useRef<TextIndex | null>(null);
  const rangesRef = useRef<Map<string, Range>>(new Map());
  const [pendingNote, setPendingNote] = useState<PendingNote | null>(null);

  const quoteAnnotations = useMemo(
    () => (annotations ?? []).filter((a) => a.quote),
    [annotations]
  );

  // Once per load, before the text index is built: clear captured popups and
  // scroll locks. Declared ahead of the paint effect so removal has already
  // reshaped the DOM when the index snapshots it.
  useEffect(() => {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (doc?.body && win) removeArchivedOverlays(doc, win);
  }, [frameGen]);

  // The text fallback's markdown, fetched only once that view is asked for.
  useEffect(() => {
    if (view !== "text" || !textUrl || textState !== null) return;
    const controller = new AbortController();
    void fetch(textUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        return response.text();
      })
      .then((markdown) => setTextState({ markdown }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setTextState({ error: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [view, textUrl, textState]);

  // Re-anchor and paint whenever the archive loads or the rows change.
  useEffect(() => {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow as
      | (Window & typeof globalThis)
      | null
      | undefined;
    if (!frame || !doc?.body || !win) return;

    if (!indexRef.current) indexRef.current = buildTextIndex(doc);
    const index = indexRef.current;

    let style = doc.getElementById("haystack-highlight-style");
    if (!style) {
      style = doc.createElement("style");
      style.id = "haystack-highlight-style";
      style.textContent = HIGHLIGHT_CSS;
      (doc.head ?? doc.body).appendChild(style);
    }

    rangesRef.current = new Map();
    const byColor = new Map<string, Range[]>();
    for (const annotation of quoteAnnotations) {
      const range = rangeFromQuote(doc, index, annotation.quote!);
      if (!range) continue; // passage gone from this archive — listed, not drawn
      rangesRef.current.set(annotation._id, range);
      const runs = byColor.get(annotation.color) ?? [];
      runs.push(range);
      byColor.set(annotation.color, runs);
    }
    const registry = win.CSS?.highlights;
    if (!registry) return; // pre-Highlight-API browser: notes still work
    for (const { key } of ANNOTATION_COLORS) {
      const runs = byColor.get(key);
      if (runs) registry.set(`haystack-${key}`, new win.Highlight(...runs));
      else registry.delete(`haystack-${key}`);
    }
    const activeRange = activeAnnotation
      ? rangesRef.current.get(activeAnnotation.id)
      : undefined;
    if (activeRange) registry.set("haystack-active", new win.Highlight(activeRange));
    else registry.delete("haystack-active");
  }, [frameGen, quoteAnnotations, activeAnnotation]);

  const commitPending = useCallback(
    async (note: PendingNote, color: AnnotationColor) => {
      const id = await createAnnotation({
        documentId,
        pageNumber: 0,
        color,
        text: note.quote.exact,
        rects: [],
        blockIds: [],
        quote: note.quote,
      });
      recordCreated(id);
      return id;
    },
    [createAnnotation, documentId, recordCreated]
  );

  // Selection → the three-option offer (or a straight commit while the pen
  // is armed); a plain click activates the highlight under it.
  useEffect(() => {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!frame || !doc?.body || !win) return;

    const onPointerUp = (event: PointerEvent) => {
      const index = indexRef.current;
      if (!index) return;
      const selection = win.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        // A click: activate the highlight under it, or dismiss everything.
        setPendingNote(null);
        const hit = [...rangesRef.current.entries()].find(([, range]) =>
          [...range.getClientRects()].some(
            (r) =>
              event.clientX >= r.left &&
              event.clientX <= r.right &&
              event.clientY >= r.top &&
              event.clientY <= r.bottom
          )
        );
        onActiveAnnotationChange?.(hit ? { id: hit[0], note: false } : null);
        return;
      }
      const quote = quoteFromRange(index, selection.getRangeAt(0));
      if (!quote) return;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const note: PendingNote = {
        anchor: {
          left: rect.left + frameRect.left,
          right: rect.right + frameRect.left,
          top: rect.top + frameRect.top,
          bottom: rect.bottom + frameRect.top,
        },
        quote,
      };
      onActiveAnnotationChange?.(null);
      if (penColor) {
        selection.removeAllRanges();
        void commitPending(note, penColor);
        return;
      }
      setPendingNote(note);
    };
    const onScrollOrResize = () => {
      // A scrolled-away selection offer would hang in space; the anchored
      // popovers follow instead, through the anchor span the effect below
      // repositions.
      setPendingNote(null);
      setAnchorVersion((v) => v + 1);
    };

    doc.addEventListener("pointerup", onPointerUp);
    win.addEventListener("scroll", onScrollOrResize, { passive: true });
    win.addEventListener("resize", onScrollOrResize);
    return () => {
      doc.removeEventListener("pointerup", onPointerUp);
      win.removeEventListener("scroll", onScrollOrResize);
      win.removeEventListener("resize", onScrollOrResize);
    };
  }, [frameGen, penColor, onActiveAnnotationChange, commitPending]);

  const settlePending = useCallback(() => {
    setPendingNote(null);
    iframeRef.current?.contentWindow?.getSelection()?.removeAllRanges();
  }, []);

  const highlightPending = useCallback(
    (openNote: boolean) => {
      if (!pendingNote) return;
      settlePending();
      void (async () => {
        const id = await commitPending(pendingNote, DEFAULT_ANNOTATION_COLOR);
        if (openNote) onActiveAnnotationChange?.({ id, note: true });
      })();
    },
    [commitPending, onActiveAnnotationChange, pendingNote, settlePending]
  );

  const copyPendingLink = useCallback(() => {
    if (!pendingNote) return;
    // No fragment deep link into an archive — the document URL is the
    // closest anchor a clipped quote has (same as the transcript).
    const pageUrl = new URL(window.location.pathname, window.location.origin);
    void navigator.clipboard.writeText(
      `“${pendingNote.quote.exact}”\n${pageUrl.href}`
    );
    settlePending();
  }, [pendingNote, settlePending]);

  // Where the active highlight's popovers hang: a fixed anchor span in the
  // app's own DOM, carrying data-annotation-anchor so useAnnotationAnchor
  // resolves it lazily. An effect keeps it glued over the highlight's range —
  // refs stay out of render, and scrolling the archive (anchorVersion) moves
  // the span, which the popover tracks.
  const activeDoc: Doc<"annotations"> | undefined = activeAnnotation
    ? quoteAnnotations.find((a) => a._id === activeAnnotation.id)
    : undefined;
  const activeDocId = activeDoc?._id;
  const anchorElRef = useRef<HTMLSpanElement>(null);

  // Activating a highlight (e.g. from the notes list) scrolls its passage
  // into view; no-op when it's already visible. The scroll event this fires
  // bumps anchorVersion, which re-runs the positioning effect below.
  useEffect(() => {
    if (!activeDocId) return;
    const passage = rangesRef.current.get(activeDocId)?.startContainer
      .parentElement;
    if (passage) smoothScrollIntoView(passage, { block: "nearest" });
  }, [activeDocId, frameGen]);

  useEffect(() => {
    const el = anchorElRef.current;
    if (!el || !activeDocId) return;
    const range = rangesRef.current.get(activeDocId);
    const frameRect = iframeRef.current?.getBoundingClientRect();
    if (!range || !frameRect) {
      el.style.display = "none";
      return;
    }
    const rect = range.getBoundingClientRect();
    el.style.display = "block";
    el.style.left = `${rect.left + frameRect.left}px`;
    el.style.top = `${rect.top + frameRect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }, [activeDocId, anchorVersion, frameGen]);

  if (view === "text") {
    return (
      <div className="h-full w-full min-w-0 overflow-y-auto">
        {textState === null ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : "error" in textState ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="size-4" />
            Couldn&apos;t load the article text ({textState.error})
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-6 py-8">
            <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {textState.markdown}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full min-w-0">
      {state === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : "error" in state ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="size-4" />
          Couldn&apos;t load the archived page ({state.error})
        </div>
      ) : (
        // Scripts stay blocked (no allow-scripts); allow-same-origin is what
        // lets the annotation bridge above reach the selection, and
        // allow-popups lets the archive's <base target="_blank"> links open
        // the live page in a real tab, escaping the sandbox so that tab runs
        // normally.
        <iframe
          ref={iframeRef}
          srcDoc={state.html}
          onLoad={() => {
            indexRef.current = null;
            setFrameGen((generation) => generation + 1);
          }}
          title="Archived web page"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          className="flex-1 min-h-0 w-full border-0 bg-white"
        />
      )}

      {pendingNote && (
        <SelectionActions
          anchor={pendingNote.anchor}
          onHighlight={() => highlightPending(false)}
          onNote={() => highlightPending(true)}
          onCopyLink={copyPendingLink}
          onDismiss={settlePending}
        />
      )}

      {/* The fixed span the active highlight's popovers anchor to; the
          positioning effect above keeps it over the highlighted passage. */}
      {activeDoc && (
        <span
          ref={anchorElRef}
          data-annotation-anchor={activeDoc._id}
          aria-hidden="true"
          className="pointer-events-none fixed"
        />
      )}

      {activeDoc && !activeAnnotation?.note && (
        <HighlightActions
          annotation={{ ...activeDoc, rects: [] }}
          onNote={() =>
            onActiveAnnotationChange?.({ id: activeDoc._id, note: true })
          }
          onDelete={() => {
            onActiveAnnotationChange?.(null);
            void removeAnnotation({ id: activeDoc._id });
          }}
          onDismiss={() => onActiveAnnotationChange?.(null)}
        />
      )}

      {activeDoc && activeAnnotation?.note && (
        <AnnotationComment
          key={activeDoc._id}
          annotation={{ ...activeDoc, rects: [] }}
          onChangeComment={(comment) => {
            void updateAnnotation({ id: activeDoc._id, comment });
            onActiveAnnotationChange?.(null);
          }}
          onChangeColor={(color) => {
            void updateAnnotation({ id: activeDoc._id, color });
          }}
          onDelete={() => {
            onActiveAnnotationChange?.(null);
            void removeAnnotation({ id: activeDoc._id });
          }}
          onDismiss={() => onActiveAnnotationChange?.(null)}
        />
      )}
    </div>
  );
}

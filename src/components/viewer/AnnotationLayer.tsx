import { useCallback, useMemo, useState } from "react";
import { MessageSquare, MessageSquarePlus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { ANNOTATION_COLORS, annotationColor } from "./annotationColors";
import type { AnnotationColor } from "./annotationColors";
import { boundingRect, mergeSelectionRects } from "./annotationGeometry";
import type { TextBox } from "../../lib/pdfTextGeometry";

/** A viewport-pixel box a popover can hang from (a selection's client rect). */
export interface SelectionAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The fields of an `annotations` row the viewer actually draws with. */
export interface ViewerAnnotation {
  _id: string;
  pageNumber: number; // 0-indexed
  color: string;
  text: string;
  comment?: string;
  sectionTitle?: string;
  rects: TextBox[];
}

/**
 * Saved highlights for one page, drawn beneath the transparent text spans.
 *
 * `pointer-events-none` throughout, deliberately: this layer sits under the
 * text layer, and anything clickable here would swallow the pointerdown that
 * starts a text selection. Activating a highlight is a hit-test the text layer
 * performs on a plain click — see PdfViewer.
 */
export function AnnotationLayer({
  annotations,
  scale,
  activeId,
}: {
  annotations: ViewerAnnotation[];
  /** Rendered pixels per page unit. */
  scale: number;
  activeId: string | null;
}) {
  if (annotations.length === 0 || !scale) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[4]">
      {annotations.map((annotation) => {
        const color = annotationColor(annotation.color);
        const bounds = boundingRect(annotation.rects);
        const isActive = annotation._id === activeId;
        // Re-merged at paint so rows saved before line-run merging existed
        // still draw as continuous stripes. Idempotent for new rows.
        const runs = mergeSelectionRects(annotation.rects);
        return (
          <div key={annotation._id}>
            {runs.map((rect, index) => {
              // A marker stroke bleeds a little past the glyphs it covers;
              // hairline-exact boxes are what reads as choppy. Scaled with the
              // line height so zoom carries it along.
              const bleedX = rect.height * scale * 0.18;
              const bleedY = rect.height * scale * 0.1;
              return (
                <span
                  key={index}
                  aria-hidden="true"
                  className={cn(
                    "absolute rounded-[3px] transition-shadow",
                    // Multiply keeps glyphs readable through the ink instead of
                    // washing them out the way a plain alpha overlay does.
                    "mix-blend-multiply",
                    isActive && "ring-2 ring-foreground/40"
                  )}
                  style={{
                    left: rect.x * scale - bleedX,
                    top: rect.y * scale - bleedY,
                    width: rect.width * scale + bleedX * 2,
                    height: rect.height * scale + bleedY * 2,
                    backgroundColor: color.fill,
                  }}
                />
              );
            })}
            {/* The anchor the comment card measures itself against, and the
                marker that says a note is attached at all. */}
            {bounds && (
              <span
                data-annotation-anchor={annotation._id}
                className="absolute"
                style={{
                  left: bounds.x * scale,
                  top: bounds.y * scale,
                  width: bounds.width * scale,
                  height: bounds.height * scale,
                }}
              >
                {annotation.comment && (
                  <MessageSquare
                    className="absolute -right-1 -top-2 size-3 fill-background"
                    style={{ color: color.swatch }}
                    aria-hidden="true"
                  />
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Where a highlight's popovers hang from: its own `data-annotation-anchor`
 * node, or a static viewport rect for highlights that have none (transcript
 * runs render inside each turn, not in an AnnotationLayer). The DOM anchor is
 * resolved lazily on every measurement because the span unmounts when its page
 * leaves the viewer's proximity window; `data-anchor-hidden` covers that case.
 */
function useAnnotationAnchor(annotationId: string, anchorRect?: SelectionAnchor) {
  const domAnchor = useCallback(
    () =>
      window.document.querySelector<HTMLElement>(
        `[data-annotation-anchor="${annotationId}"]`
      ),
    [annotationId]
  );
  const virtualAnchor = useMemo(
    () =>
      anchorRect && {
        getBoundingClientRect: () =>
          new DOMRect(
            anchorRect.left,
            anchorRect.top,
            anchorRect.right - anchorRect.left,
            anchorRect.bottom - anchorRect.top
          ),
      },
    [anchorRect]
  );
  return virtualAnchor ?? domAnchor;
}

/**
 * The small offer that follows a highlight: add a note, or delete it. Shown
 * after a fresh drag and on a click over an existing highlight — the full
 * comment card only opens once the reader asks for the note, so a bare
 * highlight stays a one-gesture act.
 *
 * `initialFocus={false}` for the same reason the old selection menu had it:
 * stealing focus after every drag would collapse the text selection the
 * reader may still want to ⌘C.
 */
export function HighlightActions({
  annotation,
  anchorRect,
  onNote,
  onDelete,
  onDismiss,
}: {
  annotation: ViewerAnnotation;
  anchorRect?: SelectionAnchor;
  onNote: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}) {
  const anchor = useAnnotationAnchor(annotation._id, anchorRect);
  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="bottom"
        align="center"
        sideOffset={8}
        initialFocus={false}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.preventDefault()}
        className="overflow-visible rounded-lg border bg-popover p-1.5 shadow-xl data-[anchor-hidden]:invisible"
        aria-label="Highlight actions"
      >
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onNote} className="h-6 px-2">
            <MessageSquarePlus className="size-3.5" />
            {annotation.comment ? "Edit note" : "Add note"}
          </Button>
          <span className="h-5 w-px bg-border" aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="h-6 px-2 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The comment box beside a highlight.
 *
 * Anchored to the highlight's own DOM node and portalled out: the page surface
 * carries the zoom scale and the rotation transform, and a comment box that
 * rotates with the paper — or doubles in size at 2× zoom — is unusable.
 * Anchoring keeps it glued to the highlight through both.
 */
export function AnnotationComment({
  annotation,
  anchorRect,
  onChangeComment,
  onChangeColor,
  onDelete,
  onDismiss,
}: {
  annotation: ViewerAnnotation;
  /**
   * Viewport box to anchor to instead of the highlight's own DOM node — for
   * highlights that have no `data-annotation-anchor` span (the transcript,
   * whose runs render inside each turn rather than in an AnnotationLayer).
   */
  anchorRect?: SelectionAnchor;
  onChangeComment: (comment: string) => void;
  onChangeColor: (color: AnnotationColor) => void;
  onDelete: () => void;
  onDismiss: () => void;
}) {
  // Seeded once per highlight: the parent keys this component on the
  // annotation id, so activating a different one remounts rather than
  // carrying the previous highlight's half-typed draft across.
  const [draft, setDraft] = useState(annotation.comment ?? "");

  const annotationId = annotation._id;
  const anchor = useAnnotationAnchor(annotationId, anchorRect);

  const dirty = draft.trim() !== (annotation.comment ?? "").trim();

  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
    <PopoverContent
      anchor={anchor}
      side="right"
      align="start"
      sideOffset={12}
      onPointerDown={(event) => event.stopPropagation()}
      className="w-64 overflow-visible rounded-lg border bg-popover p-2 shadow-xl data-[anchor-hidden]:invisible"
      aria-label="Highlight comment"
    >
      <p className="mb-2 line-clamp-3 border-l-2 pl-2 text-xs italic text-muted-foreground">
        {annotation.text}
      </p>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDismiss();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onChangeComment(draft);
          }
        }}
        rows={3}
        placeholder="Add a comment…"
        className={cn(
          "w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        )}
      />
      <div className="mt-2 flex items-center gap-1">
        {ANNOTATION_COLORS.map((option) => (
          <button
            key={option.key}
            type="button"
            title={`Recolor ${option.label.toLowerCase()}`}
            aria-label={`Recolor ${option.label.toLowerCase()}`}
            onClick={() => onChangeColor(option.key)}
            className={cn(
              "size-4 rounded-full transition-transform hover:scale-110",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
              annotation.color === option.key
                ? "ring-2 ring-foreground ring-offset-2 ring-offset-popover"
                : "ring-1 ring-inset ring-black/10"
            )}
            style={{ backgroundColor: option.swatch }}
          />
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onDelete}
          title="Delete highlight"
          aria-label="Delete highlight"
          className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
        {dirty ? (
          <button
            type="button"
            onClick={() => onChangeComment(draft)}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Save
          </button>
        ) : (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
          >
            Done
          </button>
        )}
      </div>
    </PopoverContent>
    </Popover>
  );
}

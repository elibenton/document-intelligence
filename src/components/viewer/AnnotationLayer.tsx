import { useCallback, useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { ANNOTATION_COLORS, annotationColor } from "./annotationColors";
import type { AnnotationColor } from "./annotationColors";
import { boundingRect } from "./annotationGeometry";
import type { TextBox } from "../../lib/pdfTextGeometry";

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
        return (
          <div key={annotation._id}>
            {annotation.rects.map((rect, index) => (
              <span
                key={index}
                aria-hidden="true"
                className={cn(
                  "absolute rounded-[2px] transition-shadow",
                  // Multiply keeps glyphs readable through the ink instead of
                  // washing them out the way a plain alpha overlay does.
                  "mix-blend-multiply",
                  isActive && "ring-2 ring-foreground/40"
                )}
                style={{
                  left: rect.x * scale,
                  top: rect.y * scale,
                  width: rect.width * scale,
                  height: rect.height * scale,
                  backgroundColor: color.fill,
                }}
              />
            ))}
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
 * The comment box beside a highlight.
 *
 * Anchored to the highlight's own DOM node and portalled out, for the same
 * reason SelectionPopover is: the page surface carries the zoom scale and the
 * rotation transform, and a comment box that rotates with the paper — or
 * doubles in size at 2× zoom — is unusable. Anchoring keeps it glued to the
 * highlight through both.
 */
export function AnnotationComment({
  annotation,
  onChangeComment,
  onChangeColor,
  onDelete,
  onDismiss,
}: {
  annotation: ViewerAnnotation;
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
  // Resolved lazily on every measurement, because the anchor span unmounts
  // when its page leaves the viewer's proximity window. `data-anchor-hidden`
  // handles that case now; previously it was a null check plus a manual
  // reposition on capture-phase scroll (the viewer scrolls inside its own
  // container, so scroll never reaches window) and on resize — about 45 lines,
  // re-run on every keystroke because `draft` was in the dependency array.
  // floating-ui's autoUpdate covers all of it.
  const anchor = useCallback(
    () =>
      window.document.querySelector<HTMLElement>(
        `[data-annotation-anchor="${annotationId}"]`
      ),
    [annotationId]
  );

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

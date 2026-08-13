import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_COLOR,
  type AnnotationColor,
} from "./annotationColors";

/** Where the popover hangs from: the selection's box, in viewport pixels. */
export interface SelectionAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface SelectionPopoverProps {
  anchor: SelectionAnchor;
  /** Pick a color and be done — the common case, one click. */
  onHighlight: (color: AnnotationColor) => void;
  /** Highlight *and* attach a comment. */
  onComment: (color: AnnotationColor, comment: string) => void;
  onDismiss: () => void;
}

const MARGIN = 8;

/**
 * The menu that appears where the user let go of the mouse.
 *
 * Fixed-positioned against the viewport rather than absolutely inside the page
 * surface: that surface carries the zoom scale and the rotation transform, and
 * a menu that rotates with the paper (or doubles in size at 2× zoom) is not a
 * menu. The selection's own client rect is already in viewport space, so this
 * costs nothing and is immune to both.
 */
export function SelectionPopover({
  anchor,
  onHighlight,
  onComment,
  onDismiss,
}: SelectionPopoverProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [commenting, setCommenting] = useState(false);
  const [color, setColor] = useState<AnnotationColor>(DEFAULT_ANNOTATION_COLOR);
  const [comment, setComment] = useState("");
  // Off-screen until measured, so the first paint isn't at an unclamped
  // position that then jumps once the width is known.
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(
    null
  );

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const { width, height } = card.getBoundingClientRect();
    const centered = (anchor.left + anchor.right) / 2 - width / 2;
    const left = Math.max(
      MARGIN,
      Math.min(centered, window.innerWidth - width - MARGIN)
    );
    // Below the selection by default; above it when the selection ends near
    // the bottom of the window and the menu would be cut off.
    const below = anchor.bottom + MARGIN;
    const top =
      below + height + MARGIN > window.innerHeight
        ? Math.max(MARGIN, anchor.top - height - MARGIN)
        : below;
    setPlacement({ left, top });
  }, [anchor, commenting]);

  // Focus the box the moment it exists, so "comment" is one click and typing.
  useEffect(() => {
    if (commenting) textareaRef.current?.focus();
  }, [commenting]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  return (
    <div
      ref={cardRef}
      // The pointerdown that would otherwise land on the page below clears the
      // selection this popover exists to act on.
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.preventDefault()}
      className={cn(
        "fixed z-50 rounded-lg border bg-popover p-1.5 shadow-xl",
        placement ? "" : "invisible"
      )}
      style={{ left: placement?.left ?? 0, top: placement?.top ?? 0 }}
      role="dialog"
      aria-label="Highlight selected text"
    >
      <div className="flex items-center gap-1">
        {ANNOTATION_COLORS.map((option) => (
          <button
            key={option.key}
            type="button"
            title={`Highlight ${option.label.toLowerCase()}`}
            aria-label={`Highlight ${option.label.toLowerCase()}`}
            aria-pressed={commenting ? color === option.key : undefined}
            onClick={() =>
              commenting ? setColor(option.key) : onHighlight(option.key)
            }
            className={cn(
              "h-6 w-6 rounded-full transition-transform hover:scale-110",
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              commenting && color === option.key
                ? "ring-2 ring-foreground ring-offset-2 ring-offset-popover"
                : "ring-1 ring-inset ring-black/10"
            )}
            style={{ backgroundColor: option.swatch }}
          />
        ))}
        {!commenting && (
          <>
            <span className="mx-0.5 h-5 w-px bg-border" />
            <button
              type="button"
              onClick={() => setCommenting(true)}
              title="Add a comment"
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium",
                "text-foreground transition-colors hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              )}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Comment
            </button>
          </>
        )}
      </div>

      {commenting && (
        <div className="mt-1.5 w-64">
          <textarea
            ref={textareaRef}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              // Enter saves; Shift+Enter is a newline, as in every other
              // comment box the user has ever used.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (comment.trim()) onComment(color, comment);
              }
            }}
            rows={3}
            placeholder="Add a comment…"
            className={cn(
              "w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm",
              "placeholder:text-muted-foreground",
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            )}
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!comment.trim()}
              onClick={() => onComment(color, comment)}
              className={cn(
                "rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground",
                "transition-opacity hover:opacity-90 disabled:opacity-40"
              )}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

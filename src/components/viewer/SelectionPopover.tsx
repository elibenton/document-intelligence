import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Popover, PopoverContent } from "@/components/ui/popover";
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

/**
 * The menu that appears where the user let go of the mouse.
 *
 * Anchored to the selection's own client rect, which is already in viewport
 * space — so it is immune to the zoom scale and rotation transform the page
 * surface carries. (A menu that rotates with the paper, or doubles in size at
 * 2× zoom, is not a menu.) Base UI's Positioner takes a VirtualElement, i.e.
 * anything with `getBoundingClientRect`, which is exactly what that rect is.
 *
 * That replaced ~35 lines of manual measure-centre-clamp-flip plus an
 * `invisible`-until-measured guard and a window-level Escape listener. The
 * window listener is the one worth noting: it fired for *every* open overlay,
 * so one Escape over the viewer also closed the stage-retry dialog.
 */
export function SelectionPopover({
  anchor,
  onHighlight,
  onComment,
  onDismiss,
}: SelectionPopoverProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [commenting, setCommenting] = useState(false);
  const [color, setColor] = useState<AnnotationColor>(DEFAULT_ANNOTATION_COLOR);
  const [comment, setComment] = useState("");

  // A VirtualElement over the selection rect. Rebuilt when the anchor moves so
  // the positioner re-measures.
  const virtualAnchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        new DOMRect(
          anchor.left,
          anchor.top,
          anchor.right - anchor.left,
          anchor.bottom - anchor.top
        ),
    }),
    [anchor]
  );

  // Focus the box the moment it exists, so "comment" is one click and typing.
  useEffect(() => {
    if (commenting) textareaRef.current?.focus();
  }, [commenting]);

  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
    <PopoverContent
      anchor={virtualAnchor}
      side="bottom"
      align="center"
      sideOffset={8}
      // Base UI steals focus into the popup by default, which collapses the
      // DOM selection this menu exists to act on.
      initialFocus={false}
      // The pointerdown that would otherwise land on the page below clears
      // that same selection.
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.preventDefault()}
      className="overflow-visible rounded-lg border bg-popover p-1.5 shadow-xl"
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
              "size-4 rounded-full transition-transform hover:scale-110",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
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
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
              )}
            >
              <MessageSquarePlus className="size-3.5" />
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
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
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
    </PopoverContent>
    </Popover>
  );
}

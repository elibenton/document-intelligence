import { useMemo } from "react";
import { Highlighter, Link, MessageSquarePlus, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";
import type { SelectionAnchor } from "./AnnotationLayer";
import { usePopoverAfterGesture } from "./usePopoverAfterGesture";

/**
 * The offer that follows a text drag while the highlighter pen is away.
 * Nothing is committed yet — the selection is just a selection until one of
 * these is chosen: highlight it, highlight it and open the note card, or the
 * third slot — copy-with-link on documents, fix-the-transcript on
 * recordings (`onFix` supplied means the caller can edit these words).
 *
 * `initialFocus={false}` because stealing focus would collapse the DOM
 * selection this menu exists to act on.
 */
export function SelectionActions({
  anchor,
  onHighlight,
  onNote,
  onCopyLink,
  onFix,
  onDismiss,
}: {
  /** The selection's viewport rect, where the popover hangs. */
  anchor: SelectionAnchor;
  onHighlight: () => void;
  onNote: () => void;
  onCopyLink: () => void;
  /** Replaces the third option: open the transcript-correction editor for
   *  the selected words. */
  onFix?: () => void;
  onDismiss: () => void;
}) {
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

  if (!usePopoverAfterGesture()) return null;
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
        initialFocus={false}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.preventDefault()}
        className="overflow-visible rounded-lg border bg-popover p-1.5 shadow-xl"
        aria-label="Selection actions"
      >
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onHighlight}
            className="h-6 px-2"
          >
            <Highlighter className="size-3.5" />
            Highlight
          </Button>
          <span className="h-5 w-px bg-border" aria-hidden="true" />
          <Button variant="ghost" size="sm" onClick={onNote} className="h-6 px-2">
            <MessageSquarePlus className="size-3.5" />
            Add note
          </Button>
          <span className="h-5 w-px bg-border" aria-hidden="true" />
          {onFix ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onFix}
              className="h-6 px-2"
            >
              <PencilLine className="size-3.5" />
              Fix transcript
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCopyLink}
              className="h-6 px-2"
            >
              <Link className="size-3.5" />
              Copy with link
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

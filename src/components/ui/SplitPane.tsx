import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Two panes with a divider the user can drag.
 *
 * The ratio is held locally while dragging and only committed on release, so a
 * drag is one write rather than one per animation frame. The committed value
 * is what persists; the local value is what the panes follow.
 */

const MIN_PANE_PX = 320;

export function SplitPane({
  ratio,
  defaultRatio,
  onCommit,
  left,
  right,
  className,
}: {
  /** The left pane's share, 0-1. */
  ratio: number;
  /** Restored by double-clicking the divider. */
  defaultRatio: number;
  onCommit: (ratio: number) => void;
  left: ReactNode;
  right: ReactNode;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? ratio;

  /** Keep both panes usable however narrow the window gets. */
  const clamp = useCallback((value: number) => {
    const width = containerRef.current?.clientWidth ?? 0;
    if (width <= MIN_PANE_PX * 2) return 0.5;
    const min = MIN_PANE_PX / width;
    return Math.min(1 - min, Math.max(min, value));
  }, []);

  const ratioAt = useCallback(
    (clientX: number) => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return shown;
      return clamp((clientX - box.left) / box.width);
    },
    [clamp, shown]
  );

  // Bound to the window rather than the divider so a fast drag that outruns
  // the pointer doesn't drop the gesture.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => setLive(ratioAt(event.clientX));
    const onUp = (event: PointerEvent) => {
      const final = ratioAt(event.clientX);
      setDragging(false);
      setLive(null);
      onCommit(final);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, onCommit, ratioAt]);

  // A text selection dragged along under the cursor makes the whole gesture
  // feel broken, and the resize cursor should hold across the whole window.
  useEffect(() => {
    if (!dragging) return;
    const { body } = document;
    const previousCursor = body.style.cursor;
    const previousSelect = body.style.userSelect;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    return () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousSelect;
    };
  }, [dragging]);

  return (
    <div ref={containerRef} className={cn("flex items-start", className)}>
      <div className="min-w-0" style={{ width: `${shown * 100}%` }}>
        {left}
      </div>

      <div
        role="separator"
        aria-label="Resize panels"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
          setLive(ratioAt(event.clientX));
        }}
        onDoubleClick={() => {
          setLive(null);
          onCommit(defaultRatio);
        }}
        // A divider only a mouse can move is a divider some people can't move.
        onKeyDown={(event) => {
          const step =
            event.key === "ArrowLeft" ? -0.02 : event.key === "ArrowRight" ? 0.02 : 0;
          if (step === 0) return;
          event.preventDefault();
          onCommit(clamp(ratio + step));
        }}
        title="Drag to resize · double-click to reset"
        // `--split-divider-inset` drops the rule below the panes' sticky
        // headers, so the vertical line starts where their bottom border
        // does instead of running up between the two header rows. The
        // padding is on the wrapper so the drag target follows the rule.
        className="group relative mx-4 shrink-0 self-stretch px-1 pt-[var(--split-divider-inset,0px)] cursor-col-resize outline-none"
      >
        <span
          className={cn(
            "block h-full w-px rounded-full bg-border transition-colors",
            "group-hover:bg-primary/40 group-focus-visible:bg-primary",
            dragging && "bg-primary"
          )}
        />
      </div>

      <div className="min-w-0 flex-1">{right}</div>
    </div>
  );
}

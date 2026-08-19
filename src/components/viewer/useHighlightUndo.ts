import { useCallback, useEffect, useRef } from "react";
import { isTypingTarget } from "@/lib/isTypingTarget";

/**
 * ⌘Z / Ctrl+Z over the viewer, as a generic stack: each user action pushes
 * its own inverse, and undo pops and runs the most recent one — so
 * highlights, speaker renames, and label merges revert in the order they
 * were made.
 *
 * Session-scoped by design: the stack holds only inverses this mount
 * created, so undo can never eat a change from a previous visit. Inside a
 * text field the key keeps its native meaning (see isTypingTarget). An
 * inverse may target something already gone — deleted through its own UI —
 * so inverses should swallow a not-found error rather than surface it.
 */
export function useUndoStack() {
  const stackRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) {
        return;
      }
      if (isTypingTarget(e.target)) return;
      const undo = stackRef.current.pop();
      if (!undo) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return useCallback((undo: () => void) => {
    stackRef.current.push(undo);
  }, []);
}

/** The highlight-only shape PdfViewer uses: record a created id, undo
 *  deletes it. Rides the generic stack above. */
export function useHighlightUndo(remove: (id: string) => void) {
  const pushUndo = useUndoStack();
  return useCallback(
    (id: string) => pushUndo(() => remove(id)),
    [pushUndo, remove]
  );
}

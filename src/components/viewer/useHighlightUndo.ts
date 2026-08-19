import { useCallback, useEffect, useRef } from "react";
import { isTypingTarget } from "@/lib/isTypingTarget";

/**
 * ⌘Z / Ctrl+Z over the viewer deletes the most recently created highlight.
 *
 * Session-scoped by design: the stack holds only ids this mount created, so
 * undo can never eat a highlight from a previous visit. Inside a text field
 * the key keeps its native meaning (see isTypingTarget). A popped id may
 * already be gone — deleted through the comment card — so the caller's remove
 * should swallow a not-found error rather than surface it.
 */
export function useHighlightUndo(remove: (id: string) => void) {
  const stackRef = useRef<string[]>([]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) {
        return;
      }
      if (isTypingTarget(e.target)) return;
      const id = stackRef.current.pop();
      if (!id) return;
      e.preventDefault();
      remove(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [remove]);

  return useCallback((id: string) => {
    stackRef.current.push(id);
  }, []);
}

import { useEffect } from "react";

/**
 * ⌘K / Ctrl+K, anywhere inside a project. `onTrigger` fires on every press,
 * including while the dialog it opened is still up — that is what makes the
 * shortcut close the dialog as well as open it. Pass a stable callback.
 */
export function useSearchHotkey(onTrigger: () => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "k" && e.key !== "K") return;
      if (e.altKey || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      onTrigger();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onTrigger]);
}

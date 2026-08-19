import { useEffect, useState } from "react";

/**
 * False until one macrotask after mount. The viewer's popovers open on
 * pointerup, mid-gesture — and the gesture's trailing `click` then lands on
 * the freshly mounted popup as an outside press, dismissing it on the spot
 * (measured: the selection offer died on the same drag that opened it, every
 * time). Rendering the popup one tick late puts it after that click.
 */
export function usePopoverAfterGesture(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(timer);
  }, []);
  return ready;
}

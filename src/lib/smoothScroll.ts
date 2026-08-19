/**
 * Animated jump-to for every "go to section / page / highlight" operation.
 *
 * Not `scrollIntoView({ behavior: "smooth" })`, deliberately: the PDF viewer
 * mounts text layers lazily as the scroll crosses them, and the resulting
 * reflow cancels the browser's native smooth scroll partway — a jump from
 * page 5 to page 9 simply never arrived, which read as "clicking the table
 * of contents does nothing". This drives the scroll itself with
 * requestAnimationFrame and re-derives the target from the element's *live*
 * position every frame, so a late layout shift bends the animation toward
 * the new position instead of killing it — and the jump always lands exactly
 * on the element, even when pages above it change height mid-flight.
 *
 * Works inside iframes too (the web-clip archive): everything is resolved
 * through the element's own document and window, never the globals.
 */

interface SmoothScrollOptions {
  /** "start" aligns the element's top with the scroller's top; "nearest"
   *  moves the minimum distance to bring it fully into view. */
  block?: "start" | "nearest";
}

/** One animation per scroller: a new jump cancels the one in flight. */
const inFlight = new WeakMap<Element, () => void>();

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function scrollerFor(el: HTMLElement): Element | null {
  const win = el.ownerDocument.defaultView;
  if (!win) return null;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = win.getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return el.ownerDocument.scrollingElement;
}

export function smoothScrollIntoView(
  el: HTMLElement,
  { block = "start" }: SmoothScrollOptions = {}
): void {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const scroller = scrollerFor(el);
  if (!win || !scroller) {
    el.scrollIntoView({ block });
    return;
  }

  // The element's target scrollTop, from its position right now — called
  // every frame, because the layout under the animation keeps changing.
  const targetTop = () => {
    // The root scroller's box is offset by its own scroll position, so the
    // viewport (top 0) is the reference there, not its bounding rect.
    const scrollerTop =
      scroller === doc.scrollingElement
        ? 0
        : scroller.getBoundingClientRect().top;
    const rect = el.getBoundingClientRect();
    const above = scroller.scrollTop + (rect.top - scrollerTop);
    if (block === "start") return above;
    // "nearest": already fully visible → stay put; otherwise the shorter move.
    const below = above + rect.height - scroller.clientHeight;
    if (rect.height >= scroller.clientHeight) return above;
    return Math.max(Math.min(scroller.scrollTop, above), below);
  };

  inFlight.get(scroller)?.();

  if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    scroller.scrollTop = targetTop();
    return;
  }

  const startTop = scroller.scrollTop;
  const distance = Math.abs(targetTop() - startTop);
  if (distance < 1) return;
  const duration = Math.min(600, 250 + distance * 0.1);
  const startedAt = win.performance.now();
  let frame = 0;

  // The user's hand wins: wheel or touch mid-animation hands the scroll back.
  const inputTarget = scroller === doc.scrollingElement ? win : scroller;
  const cancel = () => {
    win.cancelAnimationFrame(frame);
    inputTarget.removeEventListener("wheel", cancel);
    inputTarget.removeEventListener("touchstart", cancel);
    inFlight.delete(scroller);
  };
  inputTarget.addEventListener("wheel", cancel, { passive: true });
  inputTarget.addEventListener("touchstart", cancel, { passive: true });
  inFlight.set(scroller, cancel);

  const step = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    // Interpolate against the *current* target so the animation converges on
    // the element wherever the reflowing layout has moved it.
    const target = targetTop();
    scroller.scrollTop = target - (target - startTop) * (1 - easeInOutCubic(progress));
    if (progress < 1) {
      frame = win.requestAnimationFrame(step);
    } else {
      cancel();
    }
  };
  frame = win.requestAnimationFrame(step);
}

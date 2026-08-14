/**
 * Whether a keyboard event originated inside something the user is typing in.
 *
 * Global shortcuts registered on `window` fire regardless of focus, so ⌘F over
 * the tags input used to hijack the browser's find while the caret was in a
 * text field. Anything that calls `preventDefault()` on a bare key needs this
 * guard; ⌘K deliberately does not use it, because opening search from inside a
 * field is the point.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

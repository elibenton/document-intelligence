/**
 * The landing page demo's half of a demo session: remembering the token the
 * server minted.
 *
 * `localStorage` rather than `sessionStorage`, for two reasons that point the
 * same way. A visitor who reloads gets their document and its results back
 * instead of an empty dropzone; and because a session is good for exactly one
 * file (convex/demo.ts), the "you've used the demo, sign up to keep going"
 * state is the one that should survive a reload rather than being a new tab
 * away from being reset.
 *
 * The token is a bearer secret, so it is treated like one: nothing else reads
 * this key, and it is never put in a URL.
 */
const STORAGE_KEY = "haystack-demo-session";

/** Mirrors the server's own check, so a hand-edited value never reaches Convex. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Every accessor is guarded: Safari in private mode throws on `localStorage`
 * access rather than returning null, and a demo that cannot be *stored* should
 * still be one that can be *run*.
 */
export function storedDemoToken(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeDemoToken(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Non-fatal: the session still works for as long as this page is open.
  }
}

/**
 * Forget the session. Called when the server refuses a token it no longer
 * knows — an expired session swept by convex/demo.ts leaves a token behind
 * that would otherwise make the dropzone permanently unusable.
 */
export function clearDemoToken(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the value was unreachable to begin with.
  }
}

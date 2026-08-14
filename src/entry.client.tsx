import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { reportIssue } from "@/lib/reportIssue";

/**
 * The failures no React boundary can see.
 *
 * The root ErrorBoundary in root.tsx catches a render that threw. It cannot
 * catch a rejected promise nobody awaited, or a throw from an event handler,
 * timer or worker callback — and that is where the interesting ones live: an
 * upload retry that rejects after the card is gone, a pdf.js worker that dies
 * on one file, a fetch that fails during a background refresh. Each of those
 * currently produces a console line in a browser nobody is watching.
 *
 * Registered before hydration so a crash during hydration is still caught.
 */
window.addEventListener("error", (event) => {
  reportIssue({
    surface: "crash",
    stage: "unhandled",
    message: event.message || String(event.error),
    errorCode: event.error instanceof Error ? event.error.name : "unknown",
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  reportIssue({
    surface: "crash",
    stage: "unhandled_rejection",
    message: reason instanceof Error ? reason.message : String(reason),
    errorCode: reason instanceof Error ? reason.name : "unknown",
  });
});

// Registered only in a build: under `react-router dev` a service worker would
// serve stale modules and shadow HMR.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});

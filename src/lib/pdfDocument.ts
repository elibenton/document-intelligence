import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useState } from "react";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * One PDFDocumentProxy per file URL, shared by everything on screen.
 *
 * The viewer, quote previews, and the evidence carousel can all be showing
 * pages of the same document at once. Each pdf.js document owns a worker and a
 * parsed object graph, so opening one per component would multiply both. The
 * cache is keyed by storage URL, which Convex returns stably for a given file
 * (verified), so it is also what lets the browser's own HTTP cache hit.
 *
 * Entries are reference counted rather than evicted on unmount: scrolling a
 * list of previews mounts and unmounts consumers constantly, and destroying the
 * document in between would re-download and re-parse the file each time.
 */
type Entry = {
  promise: Promise<PDFDocumentProxy>;
  refs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  destroy: () => void;
};

const cache = new Map<string, Entry>();

function open(url: string): Entry {
  const existing = cache.get(url);
  if (existing) return existing;

  const task = pdfjs.getDocument({
    url,
    // pdf.js defaults, deliberately. Convex storage does answer range requests
    // (Accept-Ranges: bytes, 206 + Content-Range verified by probe), but
    // disableStream/disableAutoFetch did not make pdf.js issue them here — it
    // still sent one full GET, and then any page outside the already-loaded
    // prefix hung forever waiting for bytes that were never requested. Page 10
    // of a 156-page contract sat on "Rendering page 10…" indefinitely.
    //
    // Progressive streaming with autofetch is correct in every case: pages
    // paint as their bytes arrive. The cost is that a large file is fetched in
    // full (a 15MB, 156-page contract measures ~14s at ~1MB/s), paid once —
    // Convex sends cache-control: private, max-age=2592000 on a stable URL, so
    // the browser cache serves later visits. Getting range requests to engage
    // is the open optimization; it must not be traded for pages that hang.
    disableRange: false,
  });
  const entry: Entry = {
    promise: task.promise,
    refs: 0,
    destroy: () => {
      cache.delete(url);
      void task.destroy();
    },
  };
  cache.set(url, entry);
  return entry;
}

export function acquirePdf(url: string): Promise<PDFDocumentProxy> {
  const entry = open(url);
  entry.refs++;
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  return entry.promise;
}

/**
 * Dropping to zero consumers does not destroy the document. Remounts are
 * routine — a route change, a React StrictMode double-effect, a dev hot
 * update — and destroying on each one restarts the whole download. A 15MB
 * contract takes ~14s to fetch, so an eager destroy meant a remount every few
 * seconds could keep a document permanently un-openable, which is exactly what
 * was observed. Idle documents linger briefly and are reclaimed only if nobody
 * comes back for them.
 */
const IDLE_GRACE_MS = 60_000;

export function releasePdf(url: string) {
  const entry = cache.get(url);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const current = cache.get(url);
    if (current && current.refs <= 0) current.destroy();
  }, IDLE_GRACE_MS);
}

/** Subscribe a component to the shared document for `url`. */
export function usePdfDocument(url: string | null | undefined) {
  // Each result is tagged with the url it came from, so a stale result can be
  // discarded during render rather than cleared by a setState in the effect.
  const [loaded, setLoaded] = useState<{ url: string; pdf: PDFDocumentProxy } | null>(null);
  const [failed, setFailed] = useState<{ url: string; message: string } | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    acquirePdf(url)
      .then((doc) => {
        if (!cancelled) setLoaded({ url, pdf: doc });
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailed({ url, message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
      releasePdf(url);
    };
  }, [url]);

  return {
    pdf: loaded && loaded.url === url ? loaded.pdf : null,
    error: failed && failed.url === url ? failed.message : null,
  };
}

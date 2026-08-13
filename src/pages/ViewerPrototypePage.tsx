import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { StreamingPdfViewer } from "../components/viewer/StreamingPdfViewer";
import { ImagePdfViewer } from "../components/viewer/ImagePdfViewer";

/**
 * PROTOTYPE — side-by-side comparison of the two viewer architectures, so the
 * decision to delete convex/renderPages.ts rests on measurements rather than
 * argument. Left: pre-rendered server PNGs (today). Right: pdf.js streaming the
 * original over range requests.
 *
 * Route: /prototype/viewer/:id
 */
export default function ViewerPrototypePage() {
  const { id } = useParams<{ id: string }>();
  const documentId = id as Id<"documents">;
  const document = useQuery(api.documents.get, { id: documentId });
  const url = useQuery(
    api.documents.getUrl,
    document ? { storageId: document.storageId } : "skip"
  );
  const pageImages = useQuery(api.pageImages.byDocument, { documentId });
  const pages = useQuery(api.pages.byDocument, { documentId });

  const [metrics, setMetrics] = useState<string[]>([]);
  const [jumpTo, setJumpTo] = useState<number | undefined>();
  const [jumpInput, setJumpInput] = useState("");

  const onMetric = useCallback(
    (name: string, ms: number, detail?: string) => {
      setMetrics((m) =>
        [...m, `${name}: ${ms.toFixed(0)}ms${detail ? ` (${detail})` : ""}`].slice(-14)
      );
    },
    []
  );

  const serverPageCount = pageImages?.length ?? 0;
  const pageDims = useMemo(
    () =>
      (pages ?? []).map((p) => ({
        pageNumber: p.pageNumber,
        width: p.width ?? 0,
        height: p.height ?? 0,
      })),
    [pages]
  );

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b px-4 py-2 text-sm">
        <div className="font-medium">{document?.name ?? "…"}</div>
        <div className="text-neutral-500">
          renderStatus: <b>{document?.renderStatus ?? "—"}</b> · server rasters:{" "}
          <b>{serverPageCount}</b>/{document?.renderExpectedPages ?? "?"}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            className="w-28 rounded border px-2 py-1"
            placeholder="jump to page"
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
          />
          <button
            className="rounded border px-2 py-1"
            onClick={() => setJumpTo(Number(jumpInput) || 1)}
          >
            Jump (streaming side)
          </button>
          <span className="text-xs text-neutral-500">
            {metrics[metrics.length - 1] ?? ""}
          </span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-2">
        <section className="flex min-h-0 flex-col border-r">
          <h2 className="border-b bg-neutral-50 px-3 py-1 text-xs font-medium">
            A · Server-rendered PNGs (current)
          </h2>
          <div className="min-h-0 flex-1 overflow-hidden">
            {pageImages && pages ? (
              <ImagePdfViewer
                documentId={documentId}
                pageImages={pageImages}
                pages={pageDims}
                totalPages={document?.pageCount ?? serverPageCount ?? 1}
              />
            ) : (
              <div className="p-4 text-sm text-neutral-500">Loading…</div>
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          <h2 className="border-b bg-neutral-50 px-3 py-1 text-xs font-medium">
            B · pdf.js streaming the original (prototype)
          </h2>
          <div className="min-h-0 flex-1 overflow-hidden">
            {url ? (
              <StreamingPdfViewer
                url={url}
                onMetric={onMetric}
                jumpToPage={jumpTo}
              />
            ) : (
              <div className="p-4 text-sm text-neutral-500">Loading URL…</div>
            )}
          </div>
        </section>
      </div>

      <footer className="max-h-32 overflow-y-auto border-t bg-neutral-50 px-3 py-2 font-mono text-[11px]">
        {metrics.map((m, i) => (
          <div key={i}>{m}</div>
        ))}
      </footer>
    </div>
  );
}

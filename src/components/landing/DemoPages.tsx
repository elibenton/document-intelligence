import { useLayoutEffect, useRef, useState } from "react";
import { usePdfDocument } from "@/lib/pdfDocument";
import { PdfPageCanvas } from "@/components/viewer/PdfPageCanvas";
import { DEMO_MAX_PAGES } from "../../../convex/demoLimits";

/**
 * The dropped PDF, drawn from the visitor's own copy of it.
 *
 * Nothing here waits on the server. The file is already in the browser, so the
 * pages can be on screen in the time it takes pdf.js to parse them — while the
 * upload is still in flight and long before the pipeline has an answer. That
 * ordering is the demo's whole argument: something happens immediately, and
 * the extracted answers arrive next to it.
 *
 * It also means the demo needs no read endpoint for page images, and the
 * server-side render job stays off the critical path exactly as it is for a
 * signed-in upload.
 *
 * Takes the object URL rather than the `File` on purpose. Creating it here —
 * either in a `useMemo` revoked by an effect, or in the effect itself — is the
 * version that was written first and was wrong both ways: StrictMode's
 * mount → cleanup → mount revoked the URL that the surviving memo still
 * pointed at, and pdf.js failed every page with ERR_FILE_NOT_FOUND. Minting a
 * blob URL is a side effect with a lifetime, so it belongs where the file is
 * chosen (an event handler in DemoPanel), not in a render or an effect that
 * React is free to run twice.
 */
export function DemoPages({ url }: { url: string }) {
  const { pdf, error } = usePdfDocument(url);

  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Intrinsic page ratios, filled in as pdf.js hands each page over. Until one
  // arrives the page is laid out at US Letter, which keeps the scroll height
  // from jumping when the real number lands a frame later.
  const [ratios, setRatios] = useState<Record<number, number>>({});
  const LETTER_RATIO = 11 / 8.5;

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The document may be longer than the demo reads. The browser refuses those
  // before upload, so this cap only matters for the page *list*: it is the
  // same number, said once more, rather than a second policy.
  const pageCount = Math.min(pdf?.numPages ?? 0, DEMO_MAX_PAGES);

  if (error) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        This PDF could not be opened for display. The reading pass still runs on
        the copy that was uploaded.
      </p>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-4 p-4">
      {pdf &&
        width > 0 &&
        Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNumber) => (
          <div
            key={pageNumber}
            className="overflow-hidden rounded-md border bg-white shadow-sm"
          >
            <PdfPageCanvas
              pdf={pdf}
              pageNumber={pageNumber}
              cssWidth={width}
              cssHeight={width * (ratios[pageNumber] ?? LETTER_RATIO)}
              onPageSize={(page, size) =>
                setRatios((prev) =>
                  prev[page] ? prev : { ...prev, [page]: size.height / size.width }
                )
              }
            />
          </div>
        ))}
    </div>
  );
}

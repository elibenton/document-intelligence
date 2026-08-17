import { useState, useRef } from "react";
import { Link } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { SinglePagePreview } from "@/components/viewer/SinglePagePreview";

const PREVIEW_WIDTH = 320;

interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PreviewTarget {
  documentId: Id<"documents">;
  fileUrl: string | null;
  rotation?: 0 | 90 | 180 | 270;
  mediaType: string;
  pageNumber: number; // 0-based
  bbox: Bbox | null;
  pageWidth: number | null;
  pageHeight: number | null;
}

/** Deep link into the document viewer with the highlight pre-armed. */
function viewerLink(target: PreviewTarget, highlight: string) {
  return `/documents/${target.documentId}?page=${target.pageNumber + 1}&highlight=${encodeURIComponent(
    highlight
  )}`;
}

function highlightBox(bbox: Bbox, scale: number) {
  return (
    <div
      className="absolute border-2 border-amber-400 bg-amber-300/30 rounded-sm"
      style={{
        left: bbox.x * scale,
        top: bbox.y * scale,
        width: bbox.width * scale,
        height: bbox.height * scale,
      }}
    />
  );
}

function PreviewCard({
  target,
  highlight,
}: {
  target: PreviewTarget;
  highlight: string;
}) {
  const sourceWidth = target.pageWidth ?? PREVIEW_WIDTH;
  const sourceHeight = target.pageHeight ?? PREVIEW_WIDTH;
  const imageScale = PREVIEW_WIDTH / sourceWidth;

  return (
    // pb-2 (not a margin) keeps the gap between quote and card inside the
    // hover area, so moving the pointer up into the card never leaves it
    <div className="absolute left-0 bottom-full pb-2 z-50">
      <div className="w-[336px] rounded-lg border bg-popover shadow-lg p-2 flex flex-col gap-2">
      <div className="relative overflow-hidden rounded border bg-white max-h-[420px]">
        {target.mediaType === "image" ? (
          target.fileUrl ? (
            <div
              className="relative"
              style={{ width: PREVIEW_WIDTH, height: sourceHeight * imageScale }}
            >
              <img
                src={target.fileUrl}
                alt=""
                width={PREVIEW_WIDTH}
                height={sourceHeight * imageScale}
                className="block h-full w-full"
              />
              {target.bbox && highlightBox(target.bbox, imageScale)}
            </div>
          ) : (
            <div className="h-24 flex items-center justify-center text-xs text-muted-foreground">
              Preview unavailable
            </div>
          )
        ) : (
          // The page itself, drawn by pdf.js from the original file. A DOCX
          // (no drawable file) keeps the white page with the quote boxed on it.
          <SinglePagePreview
            fileUrl={target.fileUrl}
            mediaType={target.mediaType}
            pageNumber={target.pageNumber}
            width={PREVIEW_WIDTH}
            pageWidth={target.pageWidth}
            pageHeight={target.pageHeight}
            rotation={target.rotation ?? 0}
            overlay={(scale) =>
              target.bbox ? highlightBox(target.bbox, scale) : null
            }
          />
        )}
      </div>
      <div className="flex items-center justify-between px-1">
        <span className="text-2xs text-muted-foreground">
          Page {target.pageNumber + 1}
        </span>
        <Link
          to={viewerLink(target, highlight)}
          className="text-xs font-medium text-primary hover:underline"
        >
          Open in document →
        </Link>
      </div>
      </div>
    </div>
  );
}

/**
 * Wrap a quote/snippet; hovering shows a rendered preview of the document
 * page with the quoted line highlighted, plus a jump-to-document link.
 * Pass either a ready `target` (mentions carry their bbox) or `locate` text
 * to resolve the position lazily on first hover (relationship quotes).
 */
export function QuotePreview({
  target,
  locate,
  highlight,
  children,
}: {
  target?: PreviewTarget;
  locate?: { documentId: Id<"documents">; text: string };
  highlight: string;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lazily resolve quote position (and file URL) on first hover
  const located = useQuery(
    api.blocks.locateText,
    !target && locate && hovered
      ? { documentId: locate.documentId, text: locate.text }
      : "skip"
  );

  const baseTarget = target ??
    (locate && located
      ? {
          documentId: locate.documentId,
          fileUrl: located.fileUrl,
          mediaType: located.mediaType,
          pageNumber: located.pageNumber,
          bbox: located.bbox,
          pageWidth: located.pageWidth,
          pageHeight: located.pageHeight,
        }
      : null);
  // True page geometry from `pages` — the coordinate space the bbox lives in,
  // plus any per-page viewer rotation adjustment.
  const pageDims = useQuery(
    api.pages.dimensionsByPage,
    hovered && baseTarget && baseTarget.mediaType === "pdf"
      ? {
          documentId: baseTarget.documentId,
          pageNumber: baseTarget.pageNumber,
        }
      : "skip"
  );

  const resolved: PreviewTarget | null =
    baseTarget && pageDims !== undefined
      ? {
          ...baseTarget,
          rotation: pageDims?.rotation ?? 0,
          pageWidth: pageDims?.width ?? baseTarget.pageWidth,
          pageHeight: pageDims?.height ?? baseTarget.pageHeight,
        }
      : baseTarget;

  function onEnter() {
    setHovered(true);
    if (timer.current) clearTimeout(timer.current);
    // Re-entering (e.g. moving onto the card) cancels a pending hide
    timer.current = setTimeout(() => setShown(true), shown ? 0 : 350);
  }
  function onLeave() {
    if (timer.current) clearTimeout(timer.current);
    // Grace period so brief excursions off the quote/card don't dismiss it
    timer.current = setTimeout(() => setShown(false), 200);
  }

  return (
    <span className="relative inline-block" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {children}
      {shown && resolved && (
        <PreviewCard target={resolved} highlight={highlight} />
      )}
    </span>
  );
}

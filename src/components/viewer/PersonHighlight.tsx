import type { Doc } from "../../../convex/_generated/dataModel";
import { findNameBoxes } from "./entityBoxes";

/** Page dimensions as returned by the lightweight `pages.byDocument` query. */
export interface PageDims {
  pageNumber: number;
  width?: number;
  height?: number;
  viewerRotationAdjustment?: 0 | 90 | 180 | 270;
}

interface PersonHighlightProps {
  blocks: Doc<"blocks">[];
  pages: PageDims[];
  personName: string;
  pageNumber: number; // 1-indexed viewer page
  renderedWidth: number;
}

/**
 * Overlay that highlights a person's name on a given page — word-tight when
 * the block carries word-level OCR boxes, whole-line otherwise.
 */
export function PersonHighlight({
  blocks,
  pages,
  personName,
  pageNumber,
  renderedWidth,
}: PersonHighlightProps) {
  const pageIdx = pageNumber - 1;
  const nameLower = personName.toLowerCase();

  const matchingBlocks = blocks.filter(
    (b) =>
      b.pageNumber === pageIdx &&
      b.bbox &&
      b.text.toLowerCase().includes(nameLower)
  );

  const pageData = pages.find((p) => p.pageNumber === pageIdx);
  const datalabWidth = pageData?.width;

  if (matchingBlocks.length === 0 || !datalabWidth) return null;

  const scale = renderedWidth / datalabWidth;

  return (
    <>
      {matchingBlocks.flatMap((block) => {
        const boxes = findNameBoxes(block, personName);
        return (boxes.length > 0 ? boxes : [block.bbox!]).map((bbox, i) => (
          <div
            key={`person-${block._id}-${i}`}
            className="absolute pointer-events-none"
            style={{
              left: bbox.x * scale,
              top: bbox.y * scale,
              width: bbox.width * scale,
              height: bbox.height * scale,
              backgroundColor: "rgba(168, 85, 247, 0.18)",
              border: "2px solid rgba(168, 85, 247, 0.6)",
              borderRadius: 3,
            }}
          >
            <span className="absolute -top-4 left-0 text-[9px] font-semibold leading-none px-1 py-0.5 rounded-sm whitespace-nowrap bg-purple-100 text-purple-700">
              {personName}
            </span>
          </div>
        ));
      })}
    </>
  );
}


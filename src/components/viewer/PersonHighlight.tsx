import type { Doc } from "../../../convex/_generated/dataModel";
import { findNameBoxes } from "./entityBoxes";

interface PersonMention {
  blockId: string;
  pageNumber: number; // 0-indexed
  text: string; // the block text containing the person's name
  snippet: string; // short context around the name
}

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

/**
 * Find all mentions of a person across all blocks, returning page numbers and
 * snippets. Accepts the lightweight block shape (no word boxes needed).
 */
export function findPersonMentions(
  blocks: { _id: string; text: string; pageNumber: number }[],
  personName: string
): PersonMention[] {
  const nameLower = personName.toLowerCase();
  const mentions: PersonMention[] = [];
  const seenPages = new Set<number>();

  for (const block of blocks) {
    if (!block.text.toLowerCase().includes(nameLower)) continue;

    // Build a snippet around the first occurrence
    const idx = block.text.toLowerCase().indexOf(nameLower);
    const start = Math.max(0, idx - 40);
    const end = Math.min(block.text.length, idx + personName.length + 40);
    let snippet = block.text.slice(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < block.text.length) snippet = snippet + "...";

    // Only add one mention per page to keep the list concise
    if (!seenPages.has(block.pageNumber)) {
      seenPages.add(block.pageNumber);
      mentions.push({
        blockId: block._id,
        pageNumber: block.pageNumber,
        text: block.text,
        snippet,
      });
    }
  }

  return mentions.sort((a, b) => a.pageNumber - b.pageNumber);
}

import { useMemo } from "react";
import type { Doc } from "../../../convex/_generated/dataModel";
import type { PageDims } from "./PersonHighlight";
import { findNameBoxes, nameOccurrences, overlaps, type WordBox } from "./entityBoxes";

/** Which specific mention the pointer is over. `name` drives the lighter
 * highlight on that entity's other mentions, across every rendered page. */
export interface EntityHover {
  name: string;
  instanceKey: string;
}

interface EntityHighlightsProps {
  blocks: Doc<"blocks">[];
  pages: PageDims[];
  /** Tagged entity names from the sidebar's extraction groups. */
  entityNames: string[];
  pageNumber: number; // 1-indexed
  renderedWidth: number;
  hovered: EntityHover | null;
  onHover: (hover: EntityHover | null) => void;
}

interface Mention {
  key: string;
  name: string;
  box: WordBox;
}

/**
 * Invisible hit areas over every mention of a tagged entity. Hovering one
 * reveals it, and every other mention of the same entity — on this page and on
 * the others currently mounted — lights up in a lighter shade.
 */
export function EntityHighlights({
  blocks,
  pages,
  entityNames,
  pageNumber,
  renderedWidth,
  hovered,
  onHover,
}: EntityHighlightsProps) {
  const pageIdx = pageNumber - 1;
  const pageWidth = pages.find((p) => p.pageNumber === pageIdx)?.width;

  const mentions = useMemo(() => {
    if (entityNames.length === 0) return [];
    // Longest first, so "John Smith" claims the span before "John" can.
    const names = [...entityNames].sort((a, b) => b.length - a.length);
    const found: Mention[] = [];

    for (const block of blocks) {
      if (block.pageNumber !== pageIdx || !block.bbox) continue;

      const claimed: WordBox[] = [];
      for (const name of names) {
        if (nameOccurrences(block.text, name).length === 0) continue;
        const boxes = findNameBoxes(block, name, { estimate: true });
        boxes.forEach((box, i) => {
          if (claimed.some((c) => overlaps(c, box))) return;
          claimed.push(box);
          found.push({ key: `${block._id}:${name}:${i}`, name, box });
        });
      }
    }
    return found;
  }, [blocks, entityNames, pageIdx]);

  if (mentions.length === 0 || !pageWidth) return null;

  const scale = renderedWidth / pageWidth;

  return (
    <>
      {mentions.map((mention) => {
        const isHovered = hovered?.instanceKey === mention.key;
        const isSibling = !isHovered && hovered?.name === mention.name;
        const top = mention.box.y * scale;
        // Page containers clip their overflow, so a mention at the very top of
        // the page gets its label underneath instead of above.
        const labelBelow = top < 16;

        return (
          <div
            key={mention.key}
            className="absolute pointer-events-auto transition-colors duration-100"
            style={{
              left: mention.box.x * scale,
              top,
              width: mention.box.width * scale,
              height: mention.box.height * scale,
              backgroundColor: isHovered
                ? "rgba(168, 85, 247, 0.28)"
                : isSibling
                  ? "rgba(168, 85, 247, 0.13)"
                  : "transparent",
              border: isHovered
                ? "2px solid rgba(168, 85, 247, 0.7)"
                : isSibling
                  ? "1px solid rgba(168, 85, 247, 0.3)"
                  : "2px solid transparent",
              borderRadius: 3,
              zIndex: isHovered ? 2 : 1,
            }}
            onMouseEnter={() =>
              onHover({ name: mention.name, instanceKey: mention.key })
            }
            onMouseLeave={() => onHover(null)}
          >
            {isHovered && (
              <span
                className="absolute left-0 text-[9px] font-semibold leading-none px-1 py-0.5 rounded-sm whitespace-nowrap bg-purple-100 text-purple-700 pointer-events-none"
                style={labelBelow ? { top: "100%" } : { bottom: "100%" }}
              >
                {mention.name}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";

const BLOCK_TYPE_COLORS: Record<string, { fill: string; border: string; label: string }> = {
  Text:          { fill: "rgba(59,130,246,0.12)",  border: "rgba(59,130,246,0.35)",  label: "#2563eb" },
  SectionHeader: { fill: "rgba(168,85,247,0.15)",  border: "rgba(168,85,247,0.45)",  label: "#7c3aed" },
  Table:         { fill: "rgba(34,197,94,0.15)",   border: "rgba(34,197,94,0.45)",   label: "#16a34a" },
  ListItem:      { fill: "rgba(59,130,246,0.10)",  border: "rgba(59,130,246,0.30)",  label: "#3b82f6" },
  Picture:       { fill: "rgba(249,115,22,0.15)",  border: "rgba(249,115,22,0.45)",  label: "#ea580c" },
  Caption:       { fill: "rgba(234,179,8,0.12)",   border: "rgba(234,179,8,0.35)",   label: "#ca8a04" },
  PageHeader:    { fill: "rgba(107,114,128,0.10)", border: "rgba(107,114,128,0.30)", label: "#6b7280" },
  PageFooter:    { fill: "rgba(107,114,128,0.10)", border: "rgba(107,114,128,0.30)", label: "#6b7280" },
};

const DEFAULT_COLORS = { fill: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.25)", label: "#3b82f6" };

interface BlockOverlayProps {
  blocks: Doc<"blocks">[];
  pages: Doc<"pages">[];
  pageNumber: number;
  renderedWidth: number;
}

export function BlockOverlay({ blocks, pages, pageNumber, renderedWidth }: BlockOverlayProps) {
  const updateType = useMutation(api.blocks.updateType);
  const pageIdx = pageNumber - 1;

  const pageBlocks = blocks.filter(
    (b) => b.pageNumber === pageIdx && b.bbox
  );

  const pageData = pages.find((p) => p.pageNumber === pageIdx);
  const datalabWidth = pageData?.width;

  if (pageBlocks.length === 0 || !datalabWidth) return null;

  const scale = renderedWidth / datalabWidth;

  const handleToggleType = (id: Id<"blocks">, currentType: string) => {
    const newType = currentType === "SectionHeader" ? "Text" : "SectionHeader";
    updateType({ id, blockType: newType });
  };

  return (
    <>
      {pageBlocks.map((block) => {
        const bbox = block.bbox!;
        const colors = BLOCK_TYPE_COLORS[block.blockType] ?? DEFAULT_COLORS;
        const isSectionHeader = block.blockType === "SectionHeader";

        return (
          <div
            key={block._id}
            className="absolute group pointer-events-auto"
            style={{
              left: bbox.x * scale,
              top: bbox.y * scale,
              width: bbox.width * scale,
              height: bbox.height * scale,
              backgroundColor: colors.fill,
              border: `1px solid ${colors.border}`,
              borderRadius: 2,
            }}
          >
            {/* Always-visible type label */}
            <span
              className="absolute -top-4 left-0 text-[9px] font-semibold leading-none px-1 py-0.5 rounded-sm whitespace-nowrap"
              style={{
                color: colors.label,
                backgroundColor: `${colors.border}22`,
              }}
            >
              {block.blockType}
            </span>

            {/* Hover action: toggle to/from SectionHeader */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleToggleType(block._id, block.blockType);
              }}
              className="absolute -top-4 right-0 opacity-0 group-hover:opacity-100 transition-opacity text-[9px] font-semibold leading-none px-1.5 py-0.5 rounded-sm whitespace-nowrap cursor-pointer"
              style={{
                color: isSectionHeader
                  ? BLOCK_TYPE_COLORS.Text.label
                  : BLOCK_TYPE_COLORS.SectionHeader.label,
                backgroundColor: isSectionHeader
                  ? `${BLOCK_TYPE_COLORS.Text.border}33`
                  : `${BLOCK_TYPE_COLORS.SectionHeader.border}33`,
              }}
            >
              {isSectionHeader ? "→ Text" : "→ Section"}
            </button>
          </div>
        );
      })}
    </>
  );
}

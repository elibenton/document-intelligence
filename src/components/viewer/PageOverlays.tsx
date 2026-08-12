import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { BlockOverlay } from "./BlockOverlay";
import { EntityHighlights, type EntityHover } from "./EntityHighlights";
import { PersonHighlight, type PageDims } from "./PersonHighlight";

/**
 * Overlays for a single rendered PDF page. Fetches the page's full blocks
 * (including word-level OCR boxes) on its own — with the virtualized viewer
 * only a handful of pages are mounted, so only those pages' word data ever
 * leaves the server.
 */
export function PageOverlays({
  documentId,
  pageNumber,
  pages,
  showBlocks,
  highlightTerm,
  entityNames = [],
  hoveredEntity = null,
  onHoverEntity,
  renderedWidth = 700,
}: {
  documentId: Id<"documents">;
  pageNumber: number; // 1-indexed viewer page
  pages: PageDims[];
  showBlocks: boolean;
  highlightTerm?: string;
  /** Tagged entities to make hover-revealable on the page. */
  entityNames?: string[];
  hoveredEntity?: EntityHover | null;
  onHoverEntity?: (hover: EntityHover | null) => void;
  renderedWidth?: number;
}) {
  const blocks = useQuery(api.blocks.byDocumentPage, {
    documentId,
    pageNumber: pageNumber - 1,
  });
  if (!blocks || blocks.length === 0) return null;

  // The selected entity is already drawn (and labelled) by PersonHighlight —
  // don't stack a hover highlight on top of it.
  const hoverNames = highlightTerm
    ? entityNames.filter(
        (n) => n.toLowerCase() !== highlightTerm.toLowerCase()
      )
    : entityNames;

  return (
    <>
      {showBlocks && (
        <BlockOverlay
          blocks={blocks}
          pages={pages}
          pageNumber={pageNumber}
          renderedWidth={renderedWidth}
        />
      )}
      {highlightTerm && (
        <PersonHighlight
          blocks={blocks}
          pages={pages}
          personName={highlightTerm}
          pageNumber={pageNumber}
          renderedWidth={renderedWidth}
        />
      )}
      {onHoverEntity && hoverNames.length > 0 && (
        <EntityHighlights
          blocks={blocks}
          pages={pages}
          entityNames={hoverNames}
          pageNumber={pageNumber}
          renderedWidth={renderedWidth}
          hovered={hoveredEntity}
          onHover={onHoverEntity}
        />
      )}
    </>
  );
}

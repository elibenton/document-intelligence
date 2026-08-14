import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { HighlightedSnippet } from "./TableOfContents";
import type { SearchHit } from "./blockSearch";

/** A search hit labeled with the outline section it falls under, when the
 * document has one — computed by ContentsPanel via sectionForPage. */
export interface SearchResultRow extends SearchHit {
  sectionLabel?: string;
}

interface ResultGroup {
  key: string;
  label: string;
  hits: SearchResultRow[];
}

/**
 * One entry per section, not per hit — a section with 17 matches shows its
 * heading once and 17 snippets under it, instead of repeating the heading 17
 * times. Falls back to grouping by page for documents with no outline.
 * Groups come out in document order because `hits` already arrives sorted by
 * page (searchBlocks), so a section's hits are contiguous and the first one
 * seen fixes that section's position.
 */
function groupBySection(hits: SearchResultRow[]): ResultGroup[] {
  const groups: ResultGroup[] = [];
  const indexByKey = new Map<string, number>();

  for (const hit of hits) {
    const key = hit.sectionLabel ?? `page-${hit.pageNumber}`;
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = groups.length;
      indexByKey.set(key, index);
      groups.push({
        key,
        label: hit.sectionLabel ?? `Page ${hit.pageNumber + 1}`,
        hits: [],
      });
    }
    groups[index].hits.push(hit);
  }

  return groups;
}

interface DocumentSearchProps {
  hits: SearchResultRow[];
  totalMatches: number;
  query: string;
  currentPage: number;
  /** 1-based, matching the viewer's own page numbering. */
  onNavigate: (page: number) => void;
}

/**
 * Search results, grouped by the section they fall in rather than listed
 * flat — "Section B" printed once with its matches under it, not once per
 * match. Falls back to a page number for documents with no outline.
 */
export function DocumentSearch({
  hits,
  totalMatches,
  query,
  currentPage,
  onNavigate,
}: DocumentSearchProps) {
  const groups = useMemo(() => groupBySection(hits), [hits]);

  return (
    <div className="flex flex-col">
      <div className="border-b px-3 py-2 text-xs text-foreground">
        {totalMatches} match{totalMatches !== 1 && "es"} in {groups.length}{" "}
        section{groups.length !== 1 && "s"}
      </div>
      <div className="flex flex-col">
        {groups.map((group) => (
          <div key={group.key} className="border-b border-border/50 py-1.5">
            <h4 className="truncate px-3 pb-1 text-xs font-semibold text-foreground">
              {group.label}
            </h4>
            <div className="flex flex-col">
              {group.hits.map((hit) => {
                const displayPage = hit.pageNumber + 1;
                return (
                  <button
                    key={hit.blockId}
                    onClick={() => onNavigate(displayPage)}
                    className={cn(
                      "flex items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                      currentPage === displayPage && "bg-accent/60"
                    )}
                  >
                    <p className="line-clamp-5 min-w-0 flex-1 leading-relaxed text-foreground">
                      <HighlightedSnippet text={hit.snippet} query={query} />
                    </p>
                    <span className="shrink-0 pt-px text-2xs tabular-nums text-foreground">
                      p. {displayPage}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-foreground">
            No results found.
          </p>
        )}
      </div>
    </div>
  );
}

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { HighlightedSnippet } from "./TableOfContents";
import type { SearchHit } from "./blockSearch";
import { formatTime } from "@/components/recordings/speakerColors";

interface PageGroup {
  pageNumber: number;
  hits: SearchHit[];
}

interface DocumentSearchProps {
  hits: SearchHit[];
  totalMatches: number;
  currentPage: number;
  /** 1-based, matching the viewer's own page numbering. */
  onNavigate: (page: number) => void;
  /** Recordings: seek playback to a hit instead of scrolling to a page. */
  onSeek?: (seconds: number) => void;
  /** Recordings: block id → segment start time. With `onSeek`, switches the
   *  list to a flat, timestamp-addressed view (a transcript has no pages). */
  blockStartTimes?: Map<string, number>;
}

/**
 * Search results grouped under page headers — "Page 4" printed once with
 * every match on that page beneath it. The match count sits after the
 * results rather than above them, a footer rather than a gate.
 */
export function DocumentSearch({
  hits,
  totalMatches,
  currentPage,
  onNavigate,
  onSeek,
  blockStartTimes,
}: DocumentSearchProps) {
  // Hits arrive in reading order (searchBlocks), so a page's matches are
  // contiguous — grouping is a fold, not a sort.
  const groups = useMemo(() => {
    const out: PageGroup[] = [];
    for (const hit of hits) {
      const last = out[out.length - 1];
      if (last && last.pageNumber === hit.pageNumber) last.hits.push(hit);
      else out.push({ pageNumber: hit.pageNumber, hits: [hit] });
    }
    return out;
  }, [hits]);

  // Recording: the transcript is one nominal page, so page headers say
  // nothing — a flat list addressed by each hit's segment timestamp.
  if (onSeek && blockStartTimes) {
    return (
      <div className="flex flex-col">
        {hits.map((hit) => {
          const time = blockStartTimes.get(hit.blockId);
          return (
            <button
              key={hit.key}
              onClick={() => time !== undefined && onSeek(time)}
              className="flex items-start gap-2 border-b border-border/50 px-3 py-1.5 text-left text-xs transition-colors last:border-0 hover:bg-accent"
            >
              <p className="line-clamp-3 min-w-0 flex-1 leading-relaxed text-foreground">
                <HighlightedSnippet text={hit.snippet} query={hit.matchText} />
              </p>
              {time !== undefined && (
                <span className="shrink-0 pt-px text-2xs tabular-nums text-muted-foreground">
                  {formatTime(time)}
                </span>
              )}
            </button>
          );
        })}
        {hits.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-foreground">
            No results found.
          </p>
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {totalMatches} match{totalMatches !== 1 && "es"}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {groups.map((group) => {
        const displayPage = group.pageNumber + 1;
        return (
          <div
            key={group.pageNumber}
            className="border-b border-border/50 py-1.5"
          >
            <h4
              className={cn(
                "px-3 pb-0.5 text-xs font-semibold",
                currentPage === displayPage
                  ? "text-foreground"
                  : "text-muted-foreground"
              )}
            >
              Page {displayPage}
            </h4>
            {group.hits.map((hit) => (
              <button
                key={hit.key}
                onClick={() => onNavigate(displayPage)}
                className="w-full px-3 py-1 text-left text-xs transition-colors hover:bg-accent"
              >
                <p className="line-clamp-3 leading-relaxed text-foreground">
                  <HighlightedSnippet text={hit.snippet} query={hit.matchText} />
                </p>
              </button>
            ))}
          </div>
        );
      })}
      {groups.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-foreground">
          No results found.
        </p>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {totalMatches} match{totalMatches !== 1 && "es"} on {groups.length}{" "}
          page{groups.length !== 1 && "s"}
        </p>
      )}
    </div>
  );
}

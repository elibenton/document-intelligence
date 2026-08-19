import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  TableOfContents,
  type OutlineEntry,
  type TocBlock,
} from "./TableOfContents";
import { DocumentSearch } from "./DocumentSearch";
import {
  MIN_QUERY_LENGTH,
  buildSearchIndex,
  normalizeQuery,
  searchIndex,
  type SearchHit,
} from "./blockSearch";

interface ContentsPanelProps {
  blocks: TocBlock[];
  outline?: OutlineEntry[];
  currentPage: number;
  totalPages: number;
  /** 1-based page. */
  onNavigate: (page: number) => void;
  /** Recordings: seek playback instead of scrolling. Presence marks the
   *  document as a recording for the TOC and search views. */
  onSeek?: (seconds: number) => void;
  /** Recordings: the second a search hit is spoken (word-accurate). */
  hitTime?: (hit: { blockId: string; blockOffset: number }) => number | undefined;
  /** Recordings: index of the TOC section the playhead is in (-1 = none). */
  activeSection?: number;
  /** Web clips: jump to a search hit's own text instead of a page. */
  onJumpToHit?: (hit: SearchHit) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /** The query came from clicking an entity in the details panel. */
  isEntitySearch?: boolean;
  /** A counter the page bumps on ⌘F/Ctrl+F; each bump focuses the search box. */
  focusSignal?: number;
}

/**
 * The document's navigation panel: one persistent search bar, and below it
 * either the outline (nothing typed) or search results (something typed) —
 * one view that swaps content, not a tab choice between two.
 */
export function ContentsPanel({
  blocks,
  outline,
  currentPage,
  totalPages,
  onNavigate,
  onSeek,
  hitTime,
  activeSection,
  onJumpToHit,
  searchQuery,
  onSearchChange,
  isEntitySearch,
  focusSignal,
}: ContentsPanelProps) {
  // Typing is local; the committed term is lifted on a 150ms debounce.
  // `searchQuery` stays the source of truth (an entity click sets it from
  // outside), and `draft ?? searchQuery` is the same local-over-stored pattern
  // useProjectViews uses. Without this, every keystroke re-rendered the
  // 1,600-line DocumentPage and re-scanned every block in the document.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? searchQuery;
  useEffect(() => {
    if (draft === null) return;
    const timer = setTimeout(() => {
      onSearchChange(draft);
      setDraft(null);
    }, 150);
    return () => clearTimeout(timer);
  }, [draft, onSearchChange]);

  // The index depends only on the blocks, so typing re-scans a prebuilt string
  // instead of re-normalizing every block on each committed keystroke.
  const index = useMemo(() => buildSearchIndex(blocks), [blocks]);
  const outcome = useMemo(
    () => searchIndex(index, searchQuery),
    [index, searchQuery]
  );
  const searching = normalizeQuery(searchQuery).length >= MIN_QUERY_LENGTH;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SearchBar
        query={value}
        onQueryChange={setDraft}
        isEntitySearch={isEntitySearch}
        focusSignal={focusSignal}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {searching ? (
          <DocumentSearch
            hits={outcome.hits}
            totalMatches={outcome.totalMatches}
            currentPage={currentPage}
            onNavigate={onNavigate}
            onSeek={onSeek}
            hitTime={hitTime}
            onJumpToHit={onJumpToHit}
          />
        ) : (
          <TableOfContents
            blocks={blocks}
            outline={outline}
            currentPage={currentPage}
            totalPages={totalPages}
            onNavigate={onNavigate}
            onSeek={onSeek}
            activeSection={activeSection}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The looking-glass icon and a text entry, always visible and ready to go —
 * no tab click required to start searching. No box of its own: the input sits
 * bare on this row, and the row's bottom border — the line above the TOC —
 * is all the framing it gets.
 */
function SearchBar({
  query,
  onQueryChange,
  isEntitySearch,
  focusSignal,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  isEntitySearch?: boolean;
  focusSignal?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Selecting, not just focusing, so a second ⌘F types over the old term the
  // way the browser's own find field does. A ⌘F that had to un-minimize the
  // panel first arrives here as a mount with a non-zero signal, which autoFocus
  // already covers — this effect is for the panel that was open all along.
  useEffect(() => {
    if (!focusSignal) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  return (
    <div className="relative shrink-0 border-b px-3 py-2">
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      >
        <circle cx="7" cy="7" r="5" />
        <path d="M11 11l3.5 3.5" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        placeholder="Search document…"
        value={query}
        autoFocus
        onChange={(e) => onQueryChange(e.target.value)}
        className={cn(
          "h-7 w-full bg-transparent pl-6 pr-6 text-xs focus:outline-none",
          "placeholder:text-muted-foreground",
          // An entity click filled this box; the tint says the term came
          // from the panel, not the keyboard.
          isEntitySearch && query && "text-purple-700 dark:text-purple-300"
        )}
      />
      {query && (
        <button
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
}

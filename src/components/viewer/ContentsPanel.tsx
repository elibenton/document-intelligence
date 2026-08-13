import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  TableOfContents,
  type OutlineEntry,
  type TocBlock,
} from "./TableOfContents";
import { buildTocHeaders, sectionForPage } from "./tocHeaders";
import { DocumentSearch } from "./DocumentSearch";
import { MIN_QUERY_LENGTH, searchBlocks } from "./blockSearch";

interface ContentsPanelProps {
  blocks: TocBlock[];
  outline?: OutlineEntry[];
  currentPage: number;
  totalPages: number;
  /** 1-based page. */
  onNavigate: (page: number) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /** The query came from clicking an entity in the details panel. */
  isEntitySearch?: boolean;
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
  searchQuery,
  onSearchChange,
  isEntitySearch,
}: ContentsPanelProps) {
  const headers = useMemo(
    () => buildTocHeaders(blocks, outline),
    [blocks, outline]
  );
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

  const outcome = useMemo(
    () => searchBlocks(blocks, searchQuery),
    [blocks, searchQuery]
  );
  const searching = searchQuery.trim().length >= MIN_QUERY_LENGTH;

  // Label each hit with the section it falls under, so results read as
  // places in the document rather than raw page numbers.
  const hits = useMemo(
    () =>
      outcome.hits.map((hit) => ({
        ...hit,
        sectionLabel: sectionForPage(headers, hit.pageNumber)?.text,
      })),
    [outcome.hits, headers]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SearchBar
        query={value}
        onQueryChange={setDraft}
        isEntitySearch={isEntitySearch}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {searching ? (
          <DocumentSearch
            hits={hits}
            totalMatches={outcome.totalMatches}
            query={searchQuery.trim()}
            currentPage={currentPage}
            onNavigate={onNavigate}
          />
        ) : (
          <TableOfContents
            blocks={blocks}
            outline={outline}
            currentPage={currentPage}
            totalPages={totalPages}
            onNavigate={onNavigate}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The looking-glass icon and a text entry, always visible and ready to go —
 * no tab click required to start searching. pr-9 leaves room for the panel's
 * minimize button (see ViewerLayout).
 */
function SearchBar({
  query,
  onQueryChange,
  isEntitySearch,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  isEntitySearch?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="shrink-0 border-b px-3 py-2 pr-9">
      <div className="relative">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="absolute left-2 top-1/2 -translate-y-1/2 text-foreground"
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
            "h-7 w-full rounded-md border bg-background pl-7 pr-7 text-xs focus:outline-none focus:ring-1",
            isEntitySearch && query
              ? "border-purple-300 ring-1 ring-purple-400 focus:ring-purple-500 dark:border-purple-700"
              : "focus:ring-primary"
          )}
        />
        {query && (
          <button
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

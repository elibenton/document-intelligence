import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import type { Doc, Id } from "../../../convex/_generated/dataModel";

interface TableOfContentsProps {
  blocks: Doc<"blocks">[];
  currentPage: number;
  totalPages: number;
  onNavigate: (page: number) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /** When true, the search was triggered by clicking an entity (use entity highlight color) */
  isEntitySearch?: boolean;
}

interface SearchResult {
  blockId: string;
  pageNumber: number;
  snippet: string;
}

export function TableOfContents({
  blocks,
  currentPage,
  totalPages,
  onNavigate,
  searchQuery,
  onSearchChange,
  isEntitySearch,
}: TableOfContentsProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const updateBlockType = useMutation(api.blocks.updateType);

  const [indents, setIndents] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const headers = blocks
    .filter((b) => b.blockType === "SectionHeader" && b.text.trim())
    .map((b) => ({
      id: b._id,
      text: b.text.trim(),
      pageNumber: b.pageNumber,
    }));

  const currentPage0 = currentPage - 1;

  let activeIdx = -1;
  for (let i = headers.length - 1; i >= 0; i--) {
    if (headers[i].pageNumber <= currentPage0) {
      activeIdx = i;
      break;
    }
  }

  useEffect(() => {
    if (!searchQuery) {
      activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeIdx, searchQuery]);

  // Search results
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || q.length < 2) return [];

    const results: SearchResult[] = [];
    const seenPages = new Set<number>();

    for (const block of blocks) {
      const textLower = block.text.toLowerCase();
      if (!textLower.includes(q)) continue;

      const idx = textLower.indexOf(q);
      const start = Math.max(0, idx - 30);
      const end = Math.min(block.text.length, idx + q.length + 30);
      let snippet = block.text.slice(start, end);
      if (start > 0) snippet = "…" + snippet;
      if (end < block.text.length) snippet += "…";

      // One result per page
      if (!seenPages.has(block.pageNumber)) {
        seenPages.add(block.pageNumber);
        results.push({
          blockId: block._id,
          pageNumber: block.pageNumber,
          snippet,
        });
      }
    }

    return results.sort((a, b) => a.pageNumber - b.pageNumber);
  }, [searchQuery, blocks]);

  // Total match count across all blocks
  const totalMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || q.length < 2) return 0;
    return blocks.filter((b) => b.text.toLowerCase().includes(q)).length;
  }, [searchQuery, blocks]);

  const handleDemote = useCallback(
    (id: Id<"blocks">) => {
      updateBlockType({ id, blockType: "Text" });
    },
    [updateBlockType]
  );

  const handleIndent = useCallback((id: string, delta: number) => {
    setIndents((prev) => {
      const current = prev[id] ?? 0;
      const next = Math.max(0, Math.min(3, current + delta));
      return { ...prev, [id]: next };
    });
  }, []);

  // Edit mode helpers
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleBulkIndent = useCallback(
    (delta: number) => {
      setIndents((prev) => {
        const next = { ...prev };
        for (const id of selected) {
          const current = next[id] ?? 0;
          next[id] = Math.max(0, Math.min(3, current + delta));
        }
        return next;
      });
    },
    [selected]
  );

  const handleBulkDemote = useCallback(() => {
    for (const id of selected) {
      updateBlockType({ id: id as Id<"blocks">, blockType: "Text" });
    }
    setSelected(new Set());
  }, [selected, updateBlockType]);

  const exitEdit = useCallback(() => {
    setEditing(false);
    setSelected(new Set());
  }, []);

  // Compute per-section match counts for entity/search highlighting in TOC view
  const sectionMatchData = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || q.length < 2 || headers.length === 0) return null;

    // Build page ranges for each section: [startPage, endPage)
    const sectionRanges = headers.map((h, i) => ({
      id: h.id,
      startPage: h.pageNumber,
      endPage: i + 1 < headers.length ? headers[i + 1].pageNumber : Infinity,
    }));

    // Count matches per section
    const sectionCounts = new Map<string, number>();
    let totalMatchCount = 0;

    for (const block of blocks) {
      const textLower = block.text.toLowerCase();
      if (!textLower.includes(q)) continue;
      totalMatchCount++;

      // Find which section this block belongs to
      for (let i = sectionRanges.length - 1; i >= 0; i--) {
        if (block.pageNumber >= sectionRanges[i].startPage) {
          sectionCounts.set(
            sectionRanges[i].id,
            (sectionCounts.get(sectionRanges[i].id) ?? 0) + 1
          );
          break;
        }
      }
    }

    const sectionsWithMatches = sectionRanges.filter(
      (s) => (sectionCounts.get(s.id) ?? 0) > 0
    ).length;

    return { sectionCounts, totalMatchCount, sectionsWithMatches };
  }, [searchQuery, blocks, headers]);

  const isSearching = searchQuery.trim().length >= 2;

  // Search bar (always rendered)
  const searchBar = (
    <div className="px-3 pb-2 pt-3 sticky top-0 bg-muted/30 z-10">
      <div className="relative">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          <circle cx="7" cy="7" r="5" />
          <path d="M11 11l3.5 3.5" />
        </svg>
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search document..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className={cn(
            "w-full text-xs h-7 pl-7 pr-7 rounded-md border bg-background focus:outline-none focus:ring-1",
            isEntitySearch && searchQuery
              ? "ring-1 ring-purple-400 border-purple-300 focus:ring-purple-500"
              : "focus:ring-primary"
          )}
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );

  if (headers.length === 0 && totalPages === 0) {
    return (
      <div>
        {searchBar}
        <div className="p-4 text-sm text-muted-foreground">
          Process the document to generate a table of contents.
        </div>
      </div>
    );
  }

  // When searching, show TOC with section highlighting instead of flat results
  if (isSearching && headers.length > 0 && sectionMatchData) {
    const highlightColor = isEntitySearch ? "purple" : "amber";
    const { sectionCounts, totalMatchCount, sectionsWithMatches } = sectionMatchData;

    return (
      <nav className="flex flex-col">
        {searchBar}
        <div className="px-3 py-2 text-xs text-muted-foreground border-b flex items-center justify-between">
          <span>
            {totalMatchCount} match{totalMatchCount !== 1 ? "es" : ""} in{" "}
            {sectionsWithMatches} section{sectionsWithMatches !== 1 ? "s" : ""}
          </span>
          {isEntitySearch && (
            <button
              onClick={() => onSearchChange("")}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex flex-col">
          {headers.map((header, idx) => {
            const displayPage = header.pageNumber + 1;
            const indent = indents[header.id] ?? 0;
            const matchCount = sectionCounts.get(header.id) ?? 0;
            const hasMatches = matchCount > 0;
            const isActive = idx === activeIdx;

            return (
              <div
                key={header.id}
                ref={isActive ? activeRef : undefined}
                className={cn(
                  "group relative flex items-center gap-1 text-[13px] leading-snug transition-all cursor-pointer",
                  "py-1.5 pr-3",
                  hasMatches
                    ? cn(
                        "font-medium text-foreground",
                        highlightColor === "purple"
                          ? "bg-purple-50 hover:bg-purple-100 border-l-2 border-purple-400"
                          : "bg-amber-50 hover:bg-amber-100 border-l-2 border-amber-400"
                      )
                    : "font-normal text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent"
                )}
                style={{ paddingLeft: `${(hasMatches ? 14 : 16) + indent * 16}px` }}
                onClick={() => onNavigate(displayPage)}
              >
                <span
                  className={cn(
                    "flex-1 min-w-0",
                    hasMatches ? "line-clamp-2" : "line-clamp-1"
                  )}
                >
                  {header.text}
                </span>
                {hasMatches ? (
                  <span
                    className={cn(
                      "text-xs tabular-nums font-semibold shrink-0",
                      highlightColor === "purple"
                        ? "text-purple-600"
                        : "text-amber-600"
                    )}
                  >
                    {matchCount}
                  </span>
                ) : (
                  <span className="tabular-nums text-xs text-muted-foreground/40 shrink-0">
                    {displayPage}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </nav>
    );
  }

  // Fallback: searching but no headers or no match data — show flat results
  if (isSearching) {
    return (
      <nav className="flex flex-col">
        {searchBar}
        <div className="px-3 py-2 text-xs text-muted-foreground border-b">
          {totalMatches} match{totalMatches !== 1 && "es"} across{" "}
          {searchResults.length} page{searchResults.length !== 1 && "s"}
        </div>
        <div className="flex flex-col">
          {searchResults.map((result) => {
            const displayPage = result.pageNumber + 1;
            return (
              <button
                key={result.blockId}
                onClick={() => onNavigate(displayPage)}
                className={cn(
                  "text-left px-3 py-2 text-xs transition-colors hover:bg-accent border-b border-border/50",
                  currentPage === displayPage && "bg-accent/60"
                )}
              >
                <span className="tabular-nums font-medium text-primary">
                  p. {displayPage}
                </span>
                <p className="text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                  <HighlightedSnippet text={result.snippet} query={searchQuery.trim()} />
                </p>
              </button>
            );
          })}
          {searchResults.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">
              No results found.
            </p>
          )}
        </div>
      </nav>
    );
  }

  // Pages-only fallback
  if (headers.length === 0 && totalPages > 0) {
    return (
      <nav className="flex flex-col">
        {searchBar}
        <div className="px-4 pb-3 flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Pages
          </h3>
          <span className="text-xs tabular-nums text-muted-foreground">
            {currentPage}/{totalPages}
          </span>
        </div>
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
          <button
            key={page}
            onClick={() => onNavigate(page)}
            className={cn(
              "text-left px-4 py-1.5 text-sm transition-colors hover:bg-accent flex justify-between items-baseline",
              currentPage === page &&
                "bg-accent font-semibold text-accent-foreground"
            )}
          >
            <span>Page {page}</span>
          </button>
        ))}
      </nav>
    );
  }

  return (
    <nav className="flex flex-col">
      {searchBar}
      <div className="px-4 py-2 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Contents
        </h3>
        <div className="flex items-center gap-2">
          {!editing && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {currentPage}/{totalPages}
            </span>
          )}
          <button
            onClick={editing ? exitEdit : () => setEditing(true)}
            className={cn(
              "text-xs px-1.5 py-0.5 rounded transition-colors",
              editing
                ? "text-primary font-medium hover:bg-primary/10"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            )}
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </div>

      {/* Floating toolbar when items are selected */}
      {editing && selected.size > 0 && (
        <div className="sticky top-12 z-20 mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border bg-background px-3 py-1.5 shadow-md">
          <span className="text-xs font-medium tabular-nums">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-1">
            <TocAction
              title="Outdent selected"
              disabled={[...selected].every((id) => (indents[id] ?? 0) <= 0)}
              onClick={() => handleBulkIndent(-1)}
            >
              <path d="M9 2L5 6l4 4" />
            </TocAction>
            <TocAction
              title="Indent selected"
              disabled={[...selected].every((id) => (indents[id] ?? 0) >= 3)}
              onClick={() => handleBulkIndent(1)}
            >
              <path d="M5 2l4 4-4 4" />
            </TocAction>
            <TocAction
              title="Delete selected"
              variant="destructive"
              onClick={handleBulkDemote}
            >
              <path d="M3 3l8 8M11 3l-8 8" />
            </TocAction>
          </div>
        </div>
      )}

      <div className="flex flex-col">
        {headers.map((header, idx) => {
          const isActive = idx === activeIdx;
          const displayPage = header.pageNumber + 1;
          const indent = indents[header.id] ?? 0;
          const isSelected = selected.has(header.id);

          return (
            <div
              key={header.id}
              ref={isActive ? activeRef : undefined}
              className={cn(
                "group relative flex items-center gap-1 text-[13px] leading-snug transition-all cursor-pointer",
                "py-1.5 pr-3",
                editing
                  ? isSelected
                    ? "bg-primary/10"
                    : "hover:bg-accent"
                  : isActive
                    ? "font-semibold text-foreground bg-accent/50"
                    : "font-normal text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
              style={{ paddingLeft: `${16 + indent * 16}px` }}
              onClick={() =>
                editing ? toggleSelect(header.id) : onNavigate(displayPage)
              }
            >
              {editing && (
                <span
                  className={cn(
                    "shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors",
                    isSelected
                      ? "bg-primary border-primary"
                      : "border-muted-foreground/40"
                  )}
                >
                  {isSelected && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="white"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M2 5l2.5 2.5L8 3" />
                    </svg>
                  )}
                </span>
              )}
              <span
                className={cn(
                  "flex-1 min-w-0 line-clamp-1",
                  isActive && !editing && "line-clamp-2"
                )}
              >
                {header.text}
              </span>
              {!editing && (
                <span className="tabular-nums text-xs text-muted-foreground shrink-0">
                  {displayPage}
                </span>
              )}
              {editing && (
                <div
                  className="flex items-center gap-0.5 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <TocAction
                    title="Outdent"
                    disabled={indent <= 0}
                    onClick={() => handleIndent(header.id, -1)}
                  >
                    <path d="M9 2L5 6l4 4" />
                  </TocAction>
                  <TocAction
                    title="Indent"
                    disabled={indent >= 3}
                    onClick={() => handleIndent(header.id, 1)}
                  >
                    <path d="M5 2l4 4-4 4" />
                  </TocAction>
                  <TocAction
                    title="Remove section"
                    variant="destructive"
                    onClick={() => handleDemote(header.id)}
                  >
                    <path d="M3 3l8 8M11 3l-8 8" />
                  </TocAction>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** Renders text with the search query highlighted in bold */
function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-foreground">
        {text.slice(idx, idx + query.length)}
      </span>
      {text.slice(idx + query.length)}
    </>
  );
}

function TocAction({
  children,
  title,
  disabled,
  variant,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
  variant?: "destructive";
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "w-5 h-5 flex items-center justify-center rounded transition-colors",
        "disabled:opacity-30 disabled:pointer-events-none",
        variant === "destructive"
          ? "text-red-500 hover:bg-red-100 hover:text-red-700"
          : "text-blue-500 hover:bg-blue-100 hover:text-blue-700"
      )}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        {children}
      </svg>
    </button>
  );
}

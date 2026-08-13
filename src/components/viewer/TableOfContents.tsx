import { useEffect, useRef, useState, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import type { Id } from "../../../convex/_generated/dataModel";
import { buildTocHeaders } from "./tocHeaders";

/** Lightweight block shape from `blocks.byDocument` (no word boxes / html). */
export interface TocBlock {
  _id: Id<"blocks">;
  text: string;
  pageNumber: number;
  blockType: string;
}

/** One entry of the Analyze pass's outline (`documents.tableOfContents`). */
export interface OutlineEntry {
  title: string;
  level: number;
  page: number;
}

interface TableOfContentsProps {
  blocks: TocBlock[];
  /**
   * Nested outline from Analyze. Preferred over SectionHeader blocks when
   * present: it carries real depth, whereas block headers are flat and only
   * indentable by hand.
   */
  outline?: OutlineEntry[];
  currentPage: number;
  totalPages: number;
  onNavigate: (page: number) => void;
}

export function TableOfContents({
  blocks,
  outline,
  currentPage,
  totalPages,
  onNavigate,
}: TableOfContentsProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  const updateBlockType = useMutation(api.blocks.updateType);

  const [indents, setIndents] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fromOutline = (outline ?? []).length > 0;
  const headers = buildTocHeaders(blocks, outline);

  /** Manual indent adjustments layer on top of the outline's own depth. */
  const indentOf = useCallback(
    (header: { id: string; level: number }) =>
      indents[header.id] ?? header.level - 1,
    [indents]
  );

  const currentPage0 = currentPage - 1;

  let activeIdx = -1;
  for (let i = headers.length - 1; i >= 0; i--) {
    if (headers[i].pageNumber <= currentPage0) {
      activeIdx = i;
      break;
    }
  }

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

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
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  if (headers.length === 0 && totalPages === 0) {
    return (
      <div className="p-4 text-sm text-foreground">
        Process the document to generate a table of contents.
      </div>
    );
  }

  // Pages-only fallback
  if (headers.length === 0 && totalPages > 0) {
    return (
      <nav className="flex flex-col">
        <div className="px-4 pt-3 pb-3 flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
            Pages
          </h3>
          <span className="text-xs tabular-nums text-foreground">
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
    <nav className="flex flex-col pt-2">
      {/* Editing rewrites block types, so it only applies to the
          block-derived outline. Analyze's outline isn't backed by blocks;
          re-running Analyze is how you change it. No header/title row here —
          the search bar above already says what this panel is. */}
      {!fromOutline && (
        <div className="flex justify-end px-4 pb-2">
          <button
            onClick={editing ? exitEdit : () => setEditing(true)}
            className={cn(
              "text-xs px-1.5 py-0.5 rounded transition-colors",
              editing
                ? "text-primary font-medium hover:bg-primary/10"
                : "text-foreground hover:bg-accent"
            )}
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      )}

      {/* Floating toolbar when items are selected */}
      {editing && selected.size > 0 && (
        <div className="sticky top-0 z-20 mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border bg-background px-3 py-1.5 shadow-md">
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
          const indent = indentOf(header);
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
                    : "font-normal text-foreground hover:bg-accent"
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
                  isActive && !editing && "line-clamp-2",
                  // Depth still reads as hierarchy via size, just not color.
                  header.level >= 3 && "text-xs",
                  header.level === 1 && fromOutline && "font-medium"
                )}
              >
                {header.text}
              </span>
              {!editing && (
                <span className="tabular-nums text-xs text-foreground shrink-0">
                  {displayPage}
                </span>
              )}
              {editing && (
                <div
                  className="flex items-center gap-1 shrink-0"
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
                    onClick={() => handleDemote(header.id as Id<"blocks">)}
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
export function HighlightedSnippet({ text, query }: { text: string; query: string }) {
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
          ? "text-red-500 hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-950 dark:hover:text-red-300"
          : "text-blue-500 hover:bg-blue-100 hover:text-blue-700 dark:hover:bg-blue-950 dark:hover:text-blue-300"
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

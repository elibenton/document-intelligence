import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

interface ViewerLayoutProps {
  viewer: React.ReactNode;
  sidebar: React.ReactNode;
}

const SIDEBAR_DEFAULT = 380;
const SIDEBAR_MIN = 240;
const COLLAPSE_THRESHOLD = 60;
const STORAGE_KEY = "viewer-layout";

type DragTarget = "sidebar" | null;

interface LayoutState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayoutState>;
      return {
        sidebarWidth: typeof parsed.sidebarWidth === "number" ? parsed.sidebarWidth : SIDEBAR_DEFAULT,
        sidebarCollapsed: typeof parsed.sidebarCollapsed === "boolean" ? parsed.sidebarCollapsed : false,
      };
    }
  } catch { /* ignore */ }
  return {
    sidebarWidth: SIDEBAR_DEFAULT,
    sidebarCollapsed: false,
  };
}

function saveLayout(state: LayoutState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function ViewerLayout({ viewer, sidebar }: ViewerLayoutProps) {
  // Lazy state initializer, not a ref: loadLayout() must run exactly once, and
  // reading a ref during render is what the hooks rules forbid.
  const [initial] = useState(loadLayout);
  const [sidebarWidth, setSidebarWidth] = useState(initial.sidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initial.sidebarCollapsed);

  const dragging = useRef<DragTarget>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist layout to localStorage whenever values change
  useEffect(() => {
    saveLayout({ sidebarWidth, sidebarCollapsed });
  }, [sidebarWidth, sidebarCollapsed]);

  // Restore collapsed panel
  const sidebarVisibleWidth = sidebarCollapsed ? 0 : sidebarWidth;

  const onMouseDown = useCallback(
    (target: DragTarget) => (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = target;
      startX.current = e.clientX;
      startWidth.current = sidebarVisibleWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarVisibleWidth]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;

      // Sidebar drag is inverted — dragging left makes it wider
      const newWidth = startWidth.current - delta;
      if (newWidth < COLLAPSE_THRESHOLD) {
        setSidebarCollapsed(true);
        setSidebarWidth(SIDEBAR_DEFAULT);
      } else {
        setSidebarCollapsed(false);
        setSidebarWidth(Math.max(SIDEBAR_MIN, newWidth));
      }
    };

    const onMouseUp = () => {
      dragging.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div ref={containerRef} className="flex h-full overflow-hidden">
      {/* Document viewer — center */}
      <div className="flex-1 min-w-0 overflow-hidden flex justify-center bg-muted/10">
        {viewer}
      </div>

      {/* Sidebar drag handle + panel */}
      <DragHandle
        side="left"
        collapsed={sidebarCollapsed}
        onMouseDown={onMouseDown("sidebar")}
        onDoubleClick={() => {
          if (sidebarCollapsed) {
            setSidebarCollapsed(false);
            setSidebarWidth(SIDEBAR_DEFAULT);
          } else {
            setSidebarCollapsed(true);
          }
        }}
      />
      <div
        className="overflow-y-auto shrink-0 transition-[width] duration-150"
        style={{ width: sidebarVisibleWidth }}
      >
        {!sidebarCollapsed && <div className="p-4">{sidebar}</div>}
      </div>
    </div>
  );
}

function DragHandle({
  side,
  collapsed,
  onMouseDown,
  onDoubleClick,
}: {
  side: "left" | "right";
  collapsed: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      className={cn(
        "relative shrink-0 cursor-col-resize group",
        "w-[1px] bg-border hover:bg-primary/30 active:bg-primary/50 transition-colors"
      )}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {/* Wider invisible hit area */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />

      {/* Visible grab handle — appears on hover */}
      <div
        className={cn(
          "absolute top-1/2 -translate-y-1/2 z-10",
          "w-3 h-8 rounded-full",
          "bg-border group-hover:bg-primary/40 group-active:bg-primary/60",
          "opacity-0 group-hover:opacity-100 transition-opacity",
          "flex items-center justify-center",
          side === "right" ? "-right-1.5" : "-left-1.5"
        )}
      >
        <div className="flex flex-col gap-[3px]">
          <div className="w-[3px] h-[3px] rounded-full bg-muted-foreground/60" />
          <div className="w-[3px] h-[3px] rounded-full bg-muted-foreground/60" />
          <div className="w-[3px] h-[3px] rounded-full bg-muted-foreground/60" />
        </div>
      </div>

      {/* Collapsed indicator — chevron to re-expand */}
      {collapsed && (
        <button
          className={cn(
            "absolute top-1/2 -translate-y-1/2 z-20",
            "w-5 h-10 rounded-sm",
            "bg-muted hover:bg-accent border border-border",
            "flex items-center justify-center text-muted-foreground hover:text-foreground",
            "transition-colors",
            side === "right" ? "-right-2.5" : "-left-2.5"
          )}
          onClick={(e) => {
            e.stopPropagation();
            onDoubleClick();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            {side === "right" ? (
              <path d="M3 1l4 4-4 4" />
            ) : (
              <path d="M7 1l-4 4 4 4" />
            )}
          </svg>
        </button>
      )}
    </div>
  );
}

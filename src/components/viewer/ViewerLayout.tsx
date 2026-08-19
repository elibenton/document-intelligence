import { useState, useCallback, useRef, useEffect } from "react";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  HANDLE_WIDTH,
  LEFT_MIN_WIDTH,
  SIDEBAR_MIN_WIDTH,
  resolvePanels,
} from "./panelLayout";
import { FLOATING_SURFACE } from "./surfaces";

interface ViewerLayoutProps {
  /** Navigation panel (search + contents). Omitted for documents with no pages. */
  left?: React.ReactNode;
  /** Label for the floating button that restores the left panel. */
  leftLabel?: string;
  viewer: React.ReactNode;
  /**
   * Page-view controls (zoom, view toggles) shown as a chip floating at the
   * viewer's bottom center — the same surface as the minimized-panel chips
   * that share that edge. Omitted, no chip renders.
   */
  tools?: React.ReactNode;
  sidebar: React.ReactNode;
  /** Label for the floating button that restores the right panel. */
  sidebarLabel?: string;
  /**
   * Reports how much room the viewer got and the zoom it must not auto-shrink
   * past. Drives useViewerZoom; see panelLayout for the ladder they share.
   */
  onViewerMetrics?: (viewerWidth: number, zoomFloor: number) => void;
  /**
   * A counter; every bump re-opens the left panel. ⌘F uses it to bring the
   * search box back when the panel is minimized. Zero means "never asked".
   */
  revealLeft?: number;
  /**
   * localStorage key for the remembered layout. Document types whose panels
   * should default differently (web clips close Contents) get their own key,
   * so each type remembers its owner's choice independently.
   */
  storageKey?: string;
  /** Left panel starts collapsed when nothing is stored under storageKey. */
  defaultLeftCollapsed?: boolean;
}

const LEFT_DEFAULT = 300;
const SIDEBAR_DEFAULT = 380;
const COLLAPSE_THRESHOLD = 120;
const STORAGE_KEY = "viewer-layout";

type DragTarget = "left" | "sidebar" | null;

interface LayoutState {
  leftWidth: number;
  leftCollapsed: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

function loadLayout(storageKey: string, leftCollapsedDefault: boolean): LayoutState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayoutState>;
      return {
        leftWidth:
          typeof parsed.leftWidth === "number" ? parsed.leftWidth : LEFT_DEFAULT,
        leftCollapsed:
          typeof parsed.leftCollapsed === "boolean"
            ? parsed.leftCollapsed
            : leftCollapsedDefault,
        sidebarWidth:
          typeof parsed.sidebarWidth === "number"
            ? parsed.sidebarWidth
            : SIDEBAR_DEFAULT,
        sidebarCollapsed:
          typeof parsed.sidebarCollapsed === "boolean"
            ? parsed.sidebarCollapsed
            : false,
      };
    }
  } catch { /* ignore */ }
  return {
    leftWidth: LEFT_DEFAULT,
    leftCollapsed: leftCollapsedDefault,
    sidebarWidth: SIDEBAR_DEFAULT,
    sidebarCollapsed: false,
  };
}

function saveLayout(storageKey: string, state: LayoutState) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function ViewerLayout({
  left,
  leftLabel = "Contents",
  viewer,
  tools,
  sidebar,
  sidebarLabel = "Details",
  onViewerMetrics,
  revealLeft,
  storageKey = STORAGE_KEY,
  defaultLeftCollapsed = false,
}: ViewerLayoutProps) {
  // Lazy state initializer, not a ref: loadLayout() must run exactly once, and
  // reading a ref during render is what the hooks rules forbid.
  const [initial] = useState(() => loadLayout(storageKey, defaultLeftCollapsed));
  // What the user asked for. The widths actually rendered are derived from
  // these plus the measured container width — see resolvePanels.
  const [leftPreferred, setLeftPreferred] = useState(initial.leftWidth);
  const [sidebarPreferred, setSidebarPreferred] = useState(initial.sidebarWidth);
  const [leftHidden, setLeftHidden] = useState(initial.leftCollapsed);
  const [sidebarHidden, setSidebarHidden] = useState(initial.sidebarCollapsed);
  // Navigating between documents of different types swaps the storage key
  // without a remount — reload that key's layout during render, the same
  // compare-and-set pattern as the reveal counter below.
  const [seenKey, setSeenKey] = useState(storageKey);
  if (storageKey !== seenKey) {
    setSeenKey(storageKey);
    const next = loadLayout(storageKey, defaultLeftCollapsed);
    setLeftPreferred(next.leftWidth);
    setSidebarPreferred(next.sidebarWidth);
    setLeftHidden(next.leftCollapsed);
    setSidebarHidden(next.sidebarCollapsed);
  }
  // Set when the user re-opens a panel the window width had folded away.
  const [leftPinned, setLeftPinned] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);

  const dragging = useRef<DragTarget>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // Mirrors `dragging.current` as state, for what must re-render with it:
  // the width transition turns off mid-drag (it would lag the pointer), and
  // the viewer metrics report is held until release (it re-lays-out the
  // document, far too heavy per mousemove).
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    saveLayout(storageKey, {
      leftWidth: leftPreferred,
      leftCollapsed: leftHidden,
      sidebarWidth: sidebarPreferred,
      sidebarCollapsed: sidebarHidden,
    });
  }, [storageKey, leftPreferred, leftHidden, sidebarPreferred, sidebarHidden]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // ResizeObserver fires once on observe, so this also seeds the first
    // measurement without a setState in the effect body.
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = resolvePanels({
    containerWidth,
    hasLeft: Boolean(left),
    leftPreferred,
    sidebarPreferred,
    leftHidden,
    sidebarHidden,
    leftPinned,
    sidebarPinned,
  });

  // A pin only means anything while the width is folding the panel away; drop
  // it as soon as the panel fits again so the ladder resumes control.
  if (leftPinned && !layout.leftForced) setLeftPinned(false);
  if (sidebarPinned && !layout.sidebarForced) setSidebarPinned(false);

  const { viewerWidth, zoomFloor } = layout;
  useEffect(() => {
    if (isDragging) return;
    if (viewerWidth > 0) onViewerMetrics?.(viewerWidth, zoomFloor);
  }, [onViewerMetrics, viewerWidth, zoomFloor, isDragging]);

  const onMouseDown = useCallback(
    (target: DragTarget) => (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = target;
      setIsDragging(true);
      startX.current = e.clientX;
      startWidth.current =
        target === "left" ? layout.leftWidth : layout.sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [layout.leftWidth, layout.sidebarWidth]
  );

  useEffect(() => {
    // Mousemove outpaces the frame rate; coalesce to one state write per
    // animation frame so the drag tracks the pointer instead of queueing
    // behind a backlog of renders.
    let frame = 0;
    let lastX = 0;

    const applyMove = () => {
      frame = 0;
      const target = dragging.current;
      if (!target) return;
      const delta = lastX - startX.current;

      // The sidebar sits on the right, so its drag is inverted — dragging
      // left makes it wider.
      const newWidth =
        target === "left"
          ? startWidth.current + delta
          : startWidth.current - delta;
      const setHidden = target === "left" ? setLeftHidden : setSidebarHidden;
      const setPreferred =
        target === "left" ? setLeftPreferred : setSidebarPreferred;
      const minWidth = target === "left" ? LEFT_MIN_WIDTH : SIDEBAR_MIN_WIDTH;
      const defaultWidth = target === "left" ? LEFT_DEFAULT : SIDEBAR_DEFAULT;

      if (newWidth < COLLAPSE_THRESHOLD) {
        setHidden(true);
        setPreferred(defaultWidth);
      } else {
        setHidden(false);
        setPreferred(Math.max(minWidth, newWidth));
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      lastX = e.clientX;
      if (!frame) frame = requestAnimationFrame(applyMove);
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Re-opening a panel the width folded away pins it: the user's click beats
  // the ladder, and the viewer scrolls instead.
  const toggleLeft = useCallback(() => {
    if (!layout.leftCollapsed) {
      setLeftHidden(true);
      setLeftPinned(false);
      return;
    }
    setLeftHidden(false);
    if (layout.leftForced) setLeftPinned(true);
  }, [layout.leftCollapsed, layout.leftForced]);

  // Same "user beats the ladder" pinning as toggleLeft, driven by the caller
  // bumping `revealLeft`. Adjusted during render like the pins above rather
  // than in an effect: comparing against the previous bump is what makes this
  // fire on the caller's signal alone, so `layout` can simply be read — the
  // ref this used to need existed only to dodge an effect's dependency array.
  const [seenReveal, setSeenReveal] = useState(revealLeft);
  if (revealLeft !== seenReveal) {
    setSeenReveal(revealLeft);
    if (revealLeft) {
      setLeftHidden(false);
      if (layout.leftForced) setLeftPinned(true);
    }
  }

  const toggleSidebar = useCallback(() => {
    if (!layout.sidebarCollapsed) {
      setSidebarHidden(true);
      setSidebarPinned(false);
      return;
    }
    setSidebarHidden(false);
    if (layout.sidebarForced) setSidebarPinned(true);
  }, [layout.sidebarCollapsed, layout.sidebarForced]);

  return (
    <div ref={containerRef} className="relative flex h-full overflow-hidden">
      {/* Navigation panel — left. A flat, full-height column flush against
          the viewer: the hairline border is the only divider, and the resize
          handle is an invisible overlay straddling it (no gutter). */}
      {left && (
        <div
          className={cn(
            "relative shrink-0",
            !isDragging && "transition-[width] duration-150"
          )}
          style={{ width: layout.leftWidth }}
        >
          {!layout.leftCollapsed && (
            <>
              {/* px-2 insets the content — and every full-width rule inside
                  it — from the column edges, so the nested hairlines end
                  short of the edge the way the column dividers do. */}
              <div className="h-full px-2">{left}</div>
              <DragHandle
                side="left"
                label={`Resize ${leftLabel.toLowerCase()} panel`}
                width={layout.leftWidth}
                onMouseDown={onMouseDown("left")}
                onDoubleClick={toggleLeft}
                onResize={(delta) =>
                  setLeftPreferred((w) => Math.max(LEFT_MIN_WIDTH, w + delta))
                }
              />
            </>
          )}
        </div>
      )}

      {/* Document viewer — center. No surface of its own: the pages sit
          straight on the background. */}
      <div className="relative flex flex-1 min-w-0 justify-center overflow-hidden">
        {viewer}
        {/* Page-view controls, centered on the viewer pane itself (not the
            whole row) so they stay under the document as panels resize. */}
        {tools && (
          <div
            className={cn(
              FLOATING_SURFACE,
              "absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-full px-1.5 py-1"
            )}
          >
            {tools}
          </div>
        )}
      </div>

      {/* Sidebar — right. Same flat column, mirrored. */}
      <div
        className={cn(
          "relative shrink-0",
          !isDragging && "transition-[width] duration-150"
        )}
        style={{ width: layout.sidebarWidth }}
      >
        {!layout.sidebarCollapsed && (
          <>
            <div className="h-full overflow-hidden px-2">{sidebar}</div>
            <DragHandle
              side="right"
              label={`Resize ${sidebarLabel.toLowerCase()} panel`}
              width={layout.sidebarWidth}
              onMouseDown={onMouseDown("sidebar")}
              onDoubleClick={toggleSidebar}
              onResize={(delta) =>
                setSidebarPreferred((w) =>
                  Math.max(SIDEBAR_MIN_WIDTH, w + delta)
                )
              }
            />
          </>
        )}
      </div>

      {/* Minimized panels anchor to this row's own true edges — not the
          center viewer div's, which shift with the (collapsed) left panel's
          width and would throw left-side alignment off. */}
      {left && layout.leftCollapsed && (
        <FloatingPanelButton side="left" label={leftLabel} onClick={toggleLeft} />
      )}
      {layout.sidebarCollapsed && (
        <FloatingPanelButton side="right" label={sidebarLabel} onClick={toggleSidebar} />
      )}
    </div>
  );
}

/** Where a minimized panel lives: floating over the viewer's edge. */
function FloatingPanelButton({
  side,
  label,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
}) {
  const Icon = side === "left" ? PanelLeftOpen : PanelRightOpen;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Show ${label.toLowerCase()} panel`}
      aria-label={`Show ${label.toLowerCase()} panel`}
      className={cn(
        FLOATING_SURFACE,
        "absolute bottom-3 z-30 flex items-center gap-2 rounded-full py-2.5",
        "text-sm font-medium text-foreground transition-colors hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
        side === "left" ? "left-3 pl-3 pr-4" : "right-3 pl-4 pr-3"
      )}
    >
      {side === "left" && <Icon className="size-4" />}
      {label}
      {side === "right" && <Icon className="size-4" />}
    </button>
  );
}

/**
 * The column divider and its resize handle in one: an inset hairline rule
 * (the same `w-px rounded-full bg-border` line SplitPane draws on the home
 * page) inside an invisible drag strip straddling the panel edge. The strip
 * takes no layout width (see HANDLE_WIDTH in panelLayout), so the columns
 * sit flush; hovering or dragging tints the rule like the home page divider.
 */
function DragHandle({
  side,
  label,
  width,
  onMouseDown,
  onDoubleClick,
  onResize,
}: {
  side: "left" | "right";
  label: string;
  /** Current panel width, reported as the separator's value. */
  width: number;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  /** Keyboard resize: positive delta grows the panel. */
  onResize: (delta: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize · double-click to close"
      className={cn(
        "group absolute inset-y-0 z-30 cursor-col-resize outline-none",
        side === "left" ? "-right-[5px]" : "-left-[5px]"
      )}
      style={{ width: HANDLE_WIDTH }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      // Arrow keys move the divider the way they do on SplitPane: the
      // direction is spatial, so which arrow grows the panel depends on
      // which side of the viewer it sits.
      onKeyDown={(e) => {
        const step =
          e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
        if (step === 0) return;
        e.preventDefault();
        onResize(side === "left" ? step : -step);
      }}
    >
      <div
        className={cn(
          "absolute inset-y-3 left-1/2 w-px -translate-x-1/2 rounded-full",
          "bg-border transition-colors",
          "group-hover:bg-primary/40 group-active:bg-primary",
          "group-focus-visible:bg-primary"
        )}
      />
    </div>
  );
}

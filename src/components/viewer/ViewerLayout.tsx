import { useState, useCallback, useRef, useEffect } from "react";
import { PanelLeftOpen, PanelRightOpen, PanelLeftClose, PanelRightClose } from "lucide-react";
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
  sidebar: React.ReactNode;
  /** Label for the floating button that restores the right panel. */
  sidebarLabel?: string;
  /** Floats over the bottom-left corner of the viewer (e.g. zoom controls). */
  bottomLeft?: React.ReactNode;
  /** Floats over the bottom-right corner of the viewer (e.g. processing status). */
  bottomRight?: React.ReactNode;
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

const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: LEFT_DEFAULT,
  leftCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT,
  sidebarCollapsed: false,
};

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayoutState>;
      return {
        leftWidth:
          typeof parsed.leftWidth === "number" ? parsed.leftWidth : LEFT_DEFAULT,
        leftCollapsed:
          typeof parsed.leftCollapsed === "boolean" ? parsed.leftCollapsed : false,
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
  return DEFAULT_LAYOUT;
}

function saveLayout(state: LayoutState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function ViewerLayout({
  left,
  leftLabel = "Contents",
  viewer,
  sidebar,
  sidebarLabel = "Details",
  bottomLeft,
  bottomRight,
  onViewerMetrics,
  revealLeft,
}: ViewerLayoutProps) {
  // Lazy state initializer, not a ref: loadLayout() must run exactly once, and
  // reading a ref during render is what the hooks rules forbid.
  const [initial] = useState(loadLayout);
  // What the user asked for. The widths actually rendered are derived from
  // these plus the measured container width — see resolvePanels.
  const [leftPreferred, setLeftPreferred] = useState(initial.leftWidth);
  const [sidebarPreferred, setSidebarPreferred] = useState(initial.sidebarWidth);
  const [leftHidden, setLeftHidden] = useState(initial.leftCollapsed);
  const [sidebarHidden, setSidebarHidden] = useState(initial.sidebarCollapsed);
  // Set when the user re-opens a panel the window width had folded away.
  const [leftPinned, setLeftPinned] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);

  const dragging = useRef<DragTarget>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveLayout({
      leftWidth: leftPreferred,
      leftCollapsed: leftHidden,
      sidebarWidth: sidebarPreferred,
      sidebarCollapsed: sidebarHidden,
    });
  }, [leftPreferred, leftHidden, sidebarPreferred, sidebarHidden]);

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
    if (viewerWidth > 0) onViewerMetrics?.(viewerWidth, zoomFloor);
  }, [onViewerMetrics, viewerWidth, zoomFloor]);

  const onMouseDown = useCallback(
    (target: DragTarget) => (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = target;
      startX.current = e.clientX;
      startWidth.current =
        target === "left" ? layout.leftWidth : layout.sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [layout.leftWidth, layout.sidebarWidth]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const target = dragging.current;
      if (!target) return;
      const delta = e.clientX - startX.current;

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

  // Same "user beats the ladder" pinning as toggleLeft, but read through a ref
  // so the effect fires on the caller's bump alone and not every time the
  // resolved layout changes.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    if (!revealLeft) return;
    setLeftHidden(false);
    if (layoutRef.current.leftForced) setLeftPinned(true);
  }, [revealLeft]);

  const toggleSidebar = useCallback(() => {
    if (!layout.sidebarCollapsed) {
      setSidebarHidden(true);
      setSidebarPinned(false);
      return;
    }
    setSidebarHidden(false);
    if (layout.sidebarForced) setSidebarPinned(true);
  }, [layout.sidebarCollapsed, layout.sidebarForced]);

  // bottomLeft/bottomRight live wherever their panel does: stacked as a
  // footer under it while it's open (so they read as belonging to it), and
  // only dropped onto the viewer's corner once that panel is closed and
  // there's nowhere else for them to sit.
  const leftOpen = Boolean(left) && !layout.leftCollapsed;
  const sidebarOpen = !layout.sidebarCollapsed;
  const stackBottomLeft = leftOpen && bottomLeft;
  const floatBottomLeft = bottomLeft && !stackBottomLeft;
  const stackBottomRight = sidebarOpen && bottomRight;
  const floatBottomRight = bottomRight && !stackBottomRight;

  return (
    <div ref={containerRef} className="relative flex h-full overflow-hidden">
      {/* Navigation panel — left. No surface of its own: the content passed in
          supplies its own floating card(s) (e.g. the outline box stacked over
          the processing box), so more than one can share this column. */}
      {left && (
        <>
          <div
            className="relative shrink-0 transition-[width] duration-150"
            style={{ width: layout.leftWidth }}
          >
            {!layout.leftCollapsed && (
              <>
                <div className="flex h-full flex-col gap-2">
                  <div className="min-h-0 flex-1">{left}</div>
                  {stackBottomLeft && (
                    <div className="w-full shrink-0 [&>*]:w-full [&>*]:justify-center">
                      {bottomLeft}
                    </div>
                  )}
                </div>
                <MinimizeButton
                  side="left"
                  label={`Minimize ${leftLabel.toLowerCase()} panel`}
                  onClick={toggleLeft}
                />
              </>
            )}
          </div>
          <DragHandle
            onMouseDown={onMouseDown("left")}
            onDoubleClick={toggleLeft}
          />
        </>
      )}

      {/* Document viewer — center. No surface of its own: the pages float
          straight on the canvas, which is what the panels cast onto. */}
      <div className="relative flex flex-1 min-w-0 justify-center overflow-hidden">
        {viewer}
      </div>

      {/* Sidebar drag handle + panel */}
      <DragHandle
        onMouseDown={onMouseDown("sidebar")}
        onDoubleClick={toggleSidebar}
      />
      <div
        className="relative shrink-0 transition-[width] duration-150"
        style={{ width: layout.sidebarWidth }}
      >
        {!layout.sidebarCollapsed && (
          <>
            <div className="flex h-full flex-col gap-2">
              <div className={cn(FLOATING_SURFACE, "min-h-0 flex-1 overflow-hidden")}>
                {sidebar}
              </div>
              {stackBottomRight && (
                <div className="w-full shrink-0 [&>*]:w-full">{bottomRight}</div>
              )}
            </div>
            <MinimizeButton
              side="right"
              label={`Minimize ${sidebarLabel.toLowerCase()} panel`}
              onClick={toggleSidebar}
            />
          </>
        )}
      </div>

      {/* Minimized panels, and bottomLeft/bottomRight once they have no panel
          to sit under, anchor to this row's own true edges — not the center
          viewer div's, which shift with the (collapsed) left panel's width
          plus its drag-handle gutter and would throw left-side alignment off
          by that gutter's width. */}
      {left && layout.leftCollapsed && (
        <FloatingPanelButton side="left" label={leftLabel} onClick={toggleLeft} />
      )}
      {layout.sidebarCollapsed && (
        <FloatingPanelButton side="right" label={sidebarLabel} onClick={toggleSidebar} />
      )}
      {floatBottomLeft && (
        <div className="absolute bottom-3 left-3 z-30">{bottomLeft}</div>
      )}
      {floatBottomRight && (
        <div className="absolute bottom-3 right-3 z-30">{bottomRight}</div>
      )}
    </div>
  );
}

/**
 * The in-panel minimize control: a small button in the panel's top-right
 * corner. Panel contents leave room for it (see the `pr-9` on their top rows).
 */
function MinimizeButton({
  side,
  label,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
}) {
  const Icon = side === "left" ? PanelLeftClose : PanelRightClose;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "absolute top-2 right-2 z-30 grid h-6 w-6 place-items-center rounded-md",
        "text-foreground transition-colors hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
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
        "absolute top-3 z-30 flex items-center gap-2 rounded-full py-2.5",
        "text-sm font-medium text-foreground transition-colors hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        side === "left" ? "left-3 pl-3 pr-4" : "right-3 pl-4 pr-3"
      )}
    >
      {side === "left" && <Icon className="h-4 w-4" />}
      {label}
      {side === "right" && <Icon className="h-4 w-4" />}
    </button>
  );
}

function DragHandle({
  onMouseDown,
  onDoubleClick,
}: {
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  // The gutter between a floating panel and the canvas *is* the drag target —
  // no divider line, since the panel's own edge already draws the boundary.
  return (
    <div
      className="group relative shrink-0 cursor-col-resize"
      style={{ width: HANDLE_WIDTH }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      <div
        className={cn(
          "absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2",
          "flex h-8 w-1 items-center justify-center rounded-full",
          "bg-muted-foreground/25 group-hover:bg-muted-foreground/50 group-active:bg-primary/60",
          "opacity-0 transition-opacity group-hover:opacity-100"
        )}
      />
    </div>
  );
}

import { Minus, Plus, MoveHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_ZOOM, MIN_ZOOM, zoomIn, zoomOut } from "./zoom";

interface ZoomControlProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onFitWidth: () => void;
  /** 1-based. Shown as a running counter when both are given. */
  currentPage?: number;
  totalPages?: number;
}

export function ZoomControl({
  zoom,
  onZoomChange,
  onFitWidth,
  currentPage,
  totalPages,
}: ZoomControlProps) {
  return (
    // Flat header control — no surface of its own; the buttons' own hover
    // states carry the affordance.
    <div className="inline-flex h-8 items-center rounded-md" aria-label="Zoom">
      {Boolean(currentPage && totalPages) && (
        <>
          <span className="px-3 text-xs tabular-nums text-foreground">
            {currentPage} / {totalPages}
          </span>
          <span className="h-4 w-px bg-border" aria-hidden="true" />
        </>
      )}
      <ZoomButton
        label="Zoom out"
        disabled={zoom <= MIN_ZOOM}
        onClick={() => onZoomChange(zoomOut(zoom))}
      >
        <Minus className="size-3.5" />
      </ZoomButton>
      <button
        type="button"
        onClick={() => onZoomChange(1)}
        title="Reset to 100%"
        className="min-w-[3.25rem] rounded-md px-1 py-2 text-xs tabular-nums text-foreground hover:bg-accent"
      >
        {Math.round(zoom * 100)}%
      </button>
      <ZoomButton
        label="Zoom in"
        disabled={zoom >= MAX_ZOOM}
        onClick={() => onZoomChange(zoomIn(zoom))}
      >
        <Plus className="size-3.5" />
      </ZoomButton>
      <span className="h-4 w-px bg-border" aria-hidden="true" />
      <ZoomButton label="Fit to width" onClick={onFitWidth}>
        <MoveHorizontal className="size-3.5" />
      </ZoomButton>
    </div>
  );
}

function ZoomButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "grid h-full place-items-center rounded-md px-2 py-2 text-foreground transition-colors",
        "hover:bg-accent",
        "disabled:pointer-events-none disabled:opacity-40"
      )}
    >
      {children}
    </button>
  );
}

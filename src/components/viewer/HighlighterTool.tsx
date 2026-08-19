import { Highlighter } from "lucide-react";
import { cn } from "@/lib/utils";
import { FLOATING_SURFACE } from "./surfaces";
import {
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_COLOR,
  type AnnotationColor,
} from "./annotationColors";

/**
 * The highlighter pen. While armed, any text selection in the viewer commits
 * straight to a highlight of the armed color — no popover in between. Disarmed
 * (the default), selecting text keeps offering the SelectionPopover, so the
 * pen is a mode you opt into, not a change to the existing gesture.
 *
 * The armed color is remembered across disarm/re-arm within the page's
 * lifetime because the parent owns it; this component is stateless.
 */
export function HighlighterTool({
  color,
  onChange,
}: {
  /** The armed color, or null when the pen is off. */
  color: AnnotationColor | null;
  onChange: (color: AnnotationColor | null) => void;
}) {
  return (
    <div
      className={cn(FLOATING_SURFACE, "inline-flex items-center")}
      aria-label="Highlighter"
    >
      <button
        type="button"
        onClick={() => onChange(color ? null : DEFAULT_ANNOTATION_COLOR)}
        title={color ? "Put the highlighter away" : "Pick up the highlighter"}
        aria-pressed={color !== null}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
          color ? "bg-accent text-foreground" : "text-foreground hover:bg-accent"
        )}
      >
        <Highlighter className="size-3.5" />
        Highlight
      </button>
      {color && (
        <>
          <span className="h-4 w-px bg-border" aria-hidden="true" />
          <div className="flex items-center gap-1.5 px-2.5">
            {ANNOTATION_COLORS.map((option) => (
              <button
                key={option.key}
                type="button"
                title={`Highlight ${option.label.toLowerCase()}`}
                aria-label={`Highlight ${option.label.toLowerCase()}`}
                aria-pressed={color === option.key}
                onClick={() => onChange(option.key)}
                className={cn(
                  "size-4 rounded-full transition-transform hover:scale-110",
                  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
                  color === option.key
                    ? "ring-2 ring-foreground ring-offset-2 ring-offset-popover"
                    : "ring-1 ring-inset ring-black/10"
                )}
                style={{ backgroundColor: option.swatch }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

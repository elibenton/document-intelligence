import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

/**
 * The shared Popover surface.
 *
 * Three call sites had each rediscovered this independently, and two of the
 * three had also rediscovered that `z-50` belongs on the Positioner rather
 * than the Popup — the Positioner is the portalled node. The third had not,
 * which is why open view panels were painting under `z-10` row controls. It is
 * baked in here so the question stops coming up.
 */
function PopoverContent({
  className,
  side = "bottom",
  align = "end",
  sideOffset = 6,
  anchor,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> & {
  side?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["side"];
  align?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["align"];
  sideOffset?: number;
  /**
   * Anything with `getBoundingClientRect` — a DOM node, a ref, or a virtual
   * element. The viewer uses the latter to hang a menu off a text selection.
   */
  anchor?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["anchor"];
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className="z-50"
        side={side}
        align={align}
        sideOffset={sideOffset}
        anchor={anchor}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md outline-none",
            "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150",
            "data-starting-style:scale-98 data-starting-style:opacity-0",
            "data-ending-style:scale-98 data-ending-style:opacity-0",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;

export { Popover, PopoverTrigger, PopoverContent, PopoverClose };

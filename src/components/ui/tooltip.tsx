import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Replaces the `title=` attribute for anything that carries real information.
 *
 * The app had 61 `title=`s and no tooltip primitive, plus two components with
 * comments explaining the workarounds needed because lucide icons don't accept
 * `title`. Native tooltips can't be styled, don't appear on touch, and — where
 * they sat on a Popover trigger — raced the popover they were attached to.
 *
 * `title=` is still right for a control whose visible label already names it;
 * this is for the ones where the tooltip *is* the label.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delay={400} closeDelay={100}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: React.ComponentProps<typeof TooltipPrimitive.Positioner>["side"];
}) {
  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children as React.ReactElement} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner className="z-50" side={side} sideOffset={6}>
          <TooltipPrimitive.Popup
            className={cn(
              "rounded-md bg-foreground px-2 py-1 text-2xs font-medium text-background shadow-md",
              "origin-[var(--transform-origin)] transition-[opacity,transform] duration-100",
              "data-starting-style:scale-95 data-starting-style:opacity-0",
              "data-ending-style:scale-95 data-ending-style:opacity-0"
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The shared shell for the four view controls.
 *
 * Each is an icon button that opens a panel — the same idiom the toolbar
 * already used for its filter and sort selects, kept so the row of controls
 * reads as one thing. The blue dot marks a control that is currently doing
 * something, which is what lets the user see at a glance that a list is
 * filtered rather than empty.
 */
export function ViewPopover({
  icon: Icon,
  label,
  active,
  width = "w-72",
  children,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  width?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        title={label}
        // A control that is doing something colours its own icon. The filled
        // square plus a corner dot said the same thing twice, and the square
        // collided with the one the open popup already draws — so an open
        // filter panel and an applied filter looked identical.
        className={cn(
          "relative grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-accent data-[popup-open]:bg-accent",
          active
            ? "text-active hover:text-active data-[popup-open]:text-active"
            : "text-muted-foreground hover:text-foreground data-[popup-open]:text-foreground"
        )}
      >
        <Icon className="size-3.5" />
      </PopoverTrigger>
      {/* The z-50 that keeps this above row controls now lives on the shared
          Positioner — this call site was the one missing it. */}
      <PopoverContent className={width}>{children}</PopoverContent>
    </Popover>
  );
}

/** A small labelled select, the workhorse of every panel here. */
export function MiniSelect({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  className?: string;
  placeholder?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-7 min-w-0 cursor-pointer rounded-md border bg-background px-1.5 text-xs outline-none hover:bg-accent focus:ring-1 focus:ring-ring",
        className
      )}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function PanelHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

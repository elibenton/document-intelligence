import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import type { LucideIcon } from "lucide-react";
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
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        title={label}
        className={cn(
          "relative grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground",
          active && "bg-accent text-foreground"
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {active && (
          <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-blue-500 ring-1 ring-background" />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6}>
          <Popover.Popup
            className={cn(
              width,
              "max-h-[70vh] overflow-y-auto rounded-lg border bg-popover p-2 text-popover-foreground shadow-md outline-none"
            )}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
    <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A single-value picker — Base UI's Select behind the same one-component
 * surface as Autocomplete. Every call site so far wants the same thing: a
 * flat list of {value, label} and one selected value, so that is the whole
 * API. The trigger is a real button, which keeps `<label htmlFor>` working
 * and gives us the focus/keyboard behavior the hand-styled native selects
 * were approximating.
 */
export function Select<Value extends string>({
  value,
  onValueChange,
  items,
  id,
  "aria-label": ariaLabel,
  className,
}: {
  value: Value | null;
  onValueChange: (value: Value) => void;
  items: { value: Value; label: string }[];
  id?: string;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      items={items}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring/30",
          className
        )}
      >
        <SelectPrimitive.Value className="min-w-0 truncate" />
        <SelectPrimitive.Icon className="shrink-0">
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner className="z-50" sideOffset={4}>
          <SelectPrimitive.Popup className="max-h-56 w-[var(--anchor-width)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
            <SelectPrimitive.List>
              {items.map((item) => (
                <SelectPrimitive.Item
                  key={item.value}
                  value={item.value}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-sm data-highlighted:bg-accent"
                >
                  <SelectPrimitive.ItemText className="min-w-0 truncate">
                    {item.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="shrink-0">
                    <Check className="size-3.5" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { cn } from "@/lib/utils";

/**
 * A free-text input with suggestions — Base UI's Autocomplete, not its
 * Combobox, because a value outside the list is the normal case here (the
 * speaker library suggests, it never constrains). Filtering stays with the
 * caller: pass the items you want shown; an empty list renders no popup.
 *
 * Value semantics: `onValueChange` fires for typing and for selecting an
 * item alike, so the caller holds one string and never reconciles two
 * sources of truth.
 */
export function Autocomplete({
  value,
  onValueChange,
  items,
  placeholder,
  "aria-label": ariaLabel,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  items: { value: string; label: string; hint?: string }[];
  placeholder?: string;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <AutocompletePrimitive.Root
      value={value}
      onValueChange={(next) => onValueChange(String(next ?? ""))}
      items={items.map((item) => item.value)}
    >
      <AutocompletePrimitive.Input
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={cn(
          "h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm outline-none transition-colors",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring",
          className
        )}
      />
      {items.length > 0 && (
        <AutocompletePrimitive.Portal>
          <AutocompletePrimitive.Positioner className="z-50" sideOffset={4}>
            <AutocompletePrimitive.Popup className="max-h-56 w-[var(--anchor-width)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
              <AutocompletePrimitive.List>
                {items.map((item) => (
                  <AutocompletePrimitive.Item
                    key={item.value}
                    value={item.value}
                    className="flex cursor-pointer items-baseline justify-between gap-2 rounded px-2 py-1 text-sm data-highlighted:bg-accent"
                  >
                    <span className="min-w-0 truncate">{item.label}</span>
                    {item.hint && (
                      <span className="shrink-0 text-2xs text-muted-foreground">
                        {item.hint}
                      </span>
                    )}
                  </AutocompletePrimitive.Item>
                ))}
              </AutocompletePrimitive.List>
            </AutocompletePrimitive.Popup>
          </AutocompletePrimitive.Positioner>
        </AutocompletePrimitive.Portal>
      )}
    </AutocompletePrimitive.Root>
  );
}

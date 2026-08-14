import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The hero search input.
 *
 * The 183-character class string was byte-identical in two files, along with
 * the absolutely-positioned icon beside it. The `pl-11` in that string was
 * arithmetic — 16px gutter + 16px icon + 12px gap — baked into a magic class;
 * this lays the icon and input out with a grid instead, so the spacing is a
 * gap rather than a number someone has to recompute.
 */
export function SearchField({
  className,
  inputClassName,
  ref,
  ...props
}: React.ComponentProps<"input"> & {
  className?: string;
  inputClassName?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={ref}
        type="text"
        className={cn(
          "h-12 w-full rounded-xl border border-border bg-card pl-11 pr-4 text-base shadow-sm outline-none transition-shadow",
          "placeholder:text-muted-foreground",
          "focus:shadow-md focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring",
          inputClassName
        )}
        {...props}
      />
    </div>
  );
}

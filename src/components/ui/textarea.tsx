import { cn } from "@/lib/utils";

/**
 * Six textareas had grown independently and had already drifted — three radii
 * and three focus-ring widths between them. Matches `Input`'s surface so a
 * form doesn't change materials halfway down.
 */
export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // field-sizing-content grows the box with its content — no ref, no
        // scrollHeight measurement. Chromium-only today; elsewhere it degrades
        // to the fixed `rows` box, which is what this was before.
        "w-full min-w-0 resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors",
        "field-sizing-content max-h-64",
        "placeholder:text-muted-foreground",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        "dark:bg-input/30",
        className
      )}
      {...props}
    />
  );
}

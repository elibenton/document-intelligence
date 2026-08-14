import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one empty state.
 *
 * Sixteen sites had grown their own, drifting across `py-8`/`py-10`/`py-12`,
 * centred and left-aligned, bordered and not. The distinction that actually
 * matters — and that several sites had already discovered independently — is
 * "nothing exists yet" vs "your filter matched nothing", so `filtered` is a
 * prop rather than a different component.
 */
export function EmptyState({
  title,
  description,
  action,
  variant = "block",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** `inline` for inside a panel or list; `block` for a page region. */
  variant?: "inline" | "block";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-center text-muted-foreground",
        variant === "block" ? "px-6 py-12" : "px-3 py-6",
        className
      )}
    >
      <p className={cn(variant === "block" ? "text-sm" : "text-xs", "text-foreground/70")}>
        {title}
      </p>
      {description && (
        <p className={cn("mx-auto mt-1 max-w-sm", variant === "block" ? "text-sm" : "text-xs")}>
          {description}
        </p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

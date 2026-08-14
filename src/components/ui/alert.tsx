import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CircleAlert, CircleCheck, Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Status messaging, in one place.
 *
 * Nine bespoke shapes were in the tree using four mutually incompatible reds
 * (the `destructive` token, a raw `red-600`/`red-400` pair, a `red-50`/
 * `red-950` banner fill, and a `destructive/10` tint), so the same severity
 * looked different depending on which component you happened to be looking at.
 * These route through the semantic tokens, which is also what makes them
 * survive a theme change.
 *
 * `role` is not hardcoded: an alert that is present from first paint should
 * not interrupt a screen reader, but one that appears in response to an action
 * should. Callers pass `live` for the latter.
 */
const alertVariants = cva(
  "flex gap-3 rounded-lg border px-3.5 py-3 text-sm",
  {
    variants: {
      tone: {
        error: "border-destructive/30 bg-destructive/8 text-foreground",
        warning: "border-warning/30 bg-warning/8 text-foreground",
        success: "border-success/30 bg-success/8 text-foreground",
        info: "border-border bg-muted text-foreground",
      },
    },
    defaultVariants: { tone: "info" },
  }
);

const ICONS = {
  error: CircleAlert,
  warning: AlertTriangle,
  success: CircleCheck,
  info: Info,
} as const;

const ICON_TONE = {
  error: "text-destructive",
  warning: "text-warning",
  success: "text-success",
  info: "text-muted-foreground",
} as const;

export function Alert({
  tone = "info",
  title,
  children,
  actions,
  live,
  className,
}: VariantProps<typeof alertVariants> & {
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Announce when this appears in response to something the user did. */
  live?: boolean;
  className?: string;
}) {
  const key = tone ?? "info";
  const Icon = ICONS[key];
  return (
    <div
      role={live ? "alert" : undefined}
      className={cn(alertVariants({ tone }), className)}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", ICON_TONE[key])} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && (
          <div className={cn("text-muted-foreground", title && "mt-0.5")}>
            {children}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-start gap-2">{actions}</div>}
    </div>
  );
}

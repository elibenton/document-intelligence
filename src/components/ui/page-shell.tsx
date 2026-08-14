import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The frame every window-scrolled page sits in.
 *
 * It exists for one reason: the four pages that had grown their own headers
 * had four different content widths (3xl centered, 4xl left-aligned, 6xl
 * centered, none) behind a full-bleed `px-6` header — so a page title sat at
 * the window edge while the content it titled started somewhere else. Header
 * and body now share one container, so they line up by construction rather
 * than by each page choosing the same number.
 *
 * The document viewer is deliberately not built on this: it's a fixed-height
 * workspace with its own internal scrollers, not a scrolling page.
 */
const WIDTHS = {
  /** Reading measure — forms, settings, prose. */
  prose: "max-w-3xl",
  /** The default. Lists, results, most pages. */
  wide: "max-w-5xl",
} as const;

export function PageShell({
  title,
  subtitle,
  back,
  breadcrumb,
  actions,
  width = "wide",
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Renders the one back affordance, so pages stop inventing their own. */
  back?: { to: string; label: string };
  /** Shown above the title, for pages that sit inside something. */
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  width?: keyof typeof WIDTHS;
  children: ReactNode;
}) {
  const inner = cn(WIDTHS[width], "mx-auto w-full px-6");
  return (
    <div className="flex flex-col">
      <header className="border-b border-border">
        <div className={cn(inner, "flex items-start gap-3 py-4")}>
          {back && (
            <Link
              to={back.to}
              aria-label={back.label}
              className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
            >
              <ArrowLeft className="size-4" />
            </Link>
          )}
          <div className="min-w-0 flex-1">
            {breadcrumb && (
              <div className="mb-0.5 truncate text-xs text-muted-foreground">
                {breadcrumb}
              </div>
            )}
            <h1 className="truncate text-xl font-semibold">{title}</h1>
            {subtitle && (
              <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
      </header>
      <main id="main" className={cn(inner, "flex-1 py-6")}>
        {children}
      </main>
    </div>
  );
}

/**
 * A section label inside a page. Two levels only — promoted out of
 * ViewPopover's PanelHeading, which had already got this right, because the
 * app was carrying sixteen section headers across two competing scales.
 */
export function SectionHeading({
  children,
  level = "section",
  actions,
  className,
}: {
  children: ReactNode;
  level?: "section" | "sub";
  actions?: ReactNode;
  className?: string;
}) {
  if (level === "sub") {
    return (
      <p
        className={cn(
          "px-1 pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground",
          className
        )}
      >
        {children}
      </p>
    );
  }
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3", className)}>
      <h2 className="text-lg font-semibold">{children}</h2>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

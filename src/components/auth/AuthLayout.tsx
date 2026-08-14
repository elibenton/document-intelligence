import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * The frame the sign-in and sign-up forms share: brand mark, heading, form,
 * one line of footer.
 *
 * It is not built on PageShell — that frame exists to line a page header up
 * with a scrolling body at a shared measure, and these two are a single
 * centred card with no header and nothing to scroll.
 */
export function AuthLayout({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex items-center gap-2 outline-none focus-visible:ring-3 focus-visible:ring-ring rounded-md">
          {/* Black line art, so it needs inverting to stay visible in dark. */}
          <img
            src="/haystack.png"
            alt=""
            className="size-5 shrink-0 object-contain dark:invert"
          />
          <span className="font-semibold">Haystack</span>
        </Link>

        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}

        <div className="mt-6">{children}</div>

        {footer && (
          <p className="mt-6 text-sm text-muted-foreground">{footer}</p>
        )}
      </div>
    </main>
  );
}

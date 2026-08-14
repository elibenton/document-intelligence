import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type LinksFunction,
  type MetaFunction,
} from "react-router";
import { ConvexReactClient } from "convex/react";
import {
  ConvexBetterAuthProvider,
  type AuthClient,
} from "@convex-dev/better-auth/react";
import "./index.css";
import { authClient } from "@/lib/auth-client";
import { ThemeProvider } from "@/lib/theme";
import { Spinner } from "@/components/ui/spinner";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";

const SITE_URL = "https://glorious-warbler-976.convex.site/";

/** One string, three tags. It used to be pasted into each of them in index.html. */
const DESCRIPTION =
  "Throw anything in. Get answers out. Upload PDFs, CSVs, images, and recordings — every source parsed, entities and relationships extracted, answers cited back to the page.";

/**
 * Applied before first paint so dark-mode users never see a white flash, which
 * is why it is an inline script and not an effect. Keep the storage key in sync
 * with THEME_STORAGE_KEY in src/lib/theme.tsx.
 */
const THEME_BOOTSTRAP = `(function () {
  try {
    var stored = localStorage.getItem("di-theme");
    var dark =
      stored === "dark" ||
      ((!stored || stored === "system") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {}
})();`;

export const links: LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
  { rel: "icon", type: "image/png", href: "/favicon.png", sizes: "96x96" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
  { rel: "canonical", href: SITE_URL },
];

/**
 * Rendered into the prerendered index.html at build time, so this is what a
 * crawler or a link preview reads. It is also all one ever reads: the page
 * itself is a shell until hydration, by design — see docs/react-router-
 * framework-mode-plan.md §0.
 */
export const meta: MetaFunction = () => [
  { title: "Haystack" },
  { name: "description", content: DESCRIPTION },

  // Standalone (installed) window on iOS, which ignores the manifest.
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-title", content: "Haystack" },
  {
    name: "apple-mobile-web-app-status-bar-style",
    content: "black-translucent",
  },

  {
    name: "theme-color",
    content: "#ffffff",
    media: "(prefers-color-scheme: light)",
  },
  {
    name: "theme-color",
    content: "#252525",
    media: "(prefers-color-scheme: dark)",
  },

  { property: "og:url", content: SITE_URL },
  { property: "og:type", content: "website" },
  { property: "og:site_name", content: "Haystack" },
  { property: "og:title", content: "Haystack" },
  { property: "og:description", content: DESCRIPTION },
  { property: "og:image", content: `${SITE_URL}og-image.png` },
  { property: "og:image:width", content: "1200" },
  { property: "og:image:height", content: "630" },

  { name: "twitter:card", content: "summary_large_image" },
  { name: "twitter:title", content: "Haystack" },
  { name: "twitter:description", content: DESCRIPTION },
  { name: "twitter:image", content: `${SITE_URL}og-image.png` },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // The bootstrap script below writes `class` and `style.colorScheme` onto
    // this element before React hydrates, so the client DOM deliberately does
    // not match the prerendered HTML. That is the whole point of running it
    // pre-paint, and it is invisible to React until now: index.html used to own
    // <html> and React only hydrated #root. Now that Layout renders it, the
    // mismatch has to be declared or React logs it on every load.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * What the prerendered index.html actually contains, and so what every visitor
 * sees until hydration. It is deliberately the same centred spinner that
 * <AuthLoading> renders, so the shell and the auth check are one continuous
 * state rather than two flashes.
 */
export function HydrateFallback() {
  return (
    <div className="min-h-screen flex flex-1 items-center justify-center bg-background text-foreground">
      <Spinner />
    </div>
  );
}

// A production bundle bakes VITE_* in at build time, while the deployment's own
// SITE_URL is read at runtime — so a build made with dev values looks perfect
// under `react-router dev` and fails only once deployed. Fail loudly here
// instead. At module scope this now throws during `react-router build`, which
// is where a build-time env mistake belongs.
if (import.meta.env.PROD) {
  const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;
  if (!siteUrl || siteUrl.includes("localhost")) {
    throw new Error(
      `VITE_CONVEX_SITE_URL must be the deployment's .convex.site origin in a production build (got ${siteUrl ?? "nothing"})`,
    );
  }
}

// `expectAuth` holds queries until the session resolves. Without it every gated
// query fires once unauthenticated on first paint and throws. The landing page
// demo needs the opposite policy and so builds its own client — see
// src/lib/demoConvexClient.ts.
const convex = new ConvexReactClient(
  import.meta.env.VITE_CONVEX_URL as string,
  { expectAuth: true },
);

// StrictMode wraps HydratedRouter in entry.client.tsx, so it covers Layout too.
export default function Root() {
  return (
    <ThemeProvider>
      {/* The cast is the component's own type gap, not ours: its `AuthClient`
            union is written as `createAuthClient<BetterAuthClientPlugin & …>`,
            which no client configured with a `baseURL` structurally satisfies —
            `useSession().data` collapses to `never`. Casting here rather than in
            auth-client.ts keeps full inference at every call site that actually
            signs people in. Recheck on the next component release. */}
      <ConvexBetterAuthProvider
        client={convex}
        authClient={authClient as unknown as AuthClient}
      >
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              {/* Every page's own <main> carries id="main"; the pages built on
                    PageShell get it for free. */}
              <a
                href="#main"
                className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[200] focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg focus:outline-none focus:ring-3 focus:ring-ring"
              >
                Skip to content
              </a>
              <div className="min-h-screen flex flex-col bg-background text-foreground max-w-[1800px] mx-auto">
                <Outlet />
              </div>
            </ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </ConvexBetterAuthProvider>
    </ThemeProvider>
  );
}

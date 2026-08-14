import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import {
  ConvexBetterAuthProvider,
  type AuthClient,
} from "@convex-dev/better-auth/react";
import { BrowserRouter } from "react-router";
import "./index.css";
import App from "./App.tsx";
import { authClient } from "@/lib/auth-client";
import { ThemeProvider } from "@/lib/theme";

// A production bundle bakes VITE_* in at build time, while the deployment's own
// SITE_URL is read at runtime — so a build made with dev values looks perfect
// under `vite dev` and fails only once deployed. Fail loudly here instead.
if (import.meta.env.PROD) {
  const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;
  if (!siteUrl || siteUrl.includes("localhost")) {
    throw new Error(
      `VITE_CONVEX_SITE_URL must be the deployment's .convex.site origin in a production build (got ${siteUrl ?? "nothing"})`
    );
  }
}

// `expectAuth` holds queries until the session resolves. Without it every gated
// query fires once unauthenticated on first paint and throws.
const convex = new ConvexReactClient(
  import.meta.env.VITE_CONVEX_URL as string,
  { expectAuth: true }
);

// Registered only in a build: under `vite dev` a service worker would serve
// stale modules and shadow HMR.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
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
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConvexBetterAuthProvider>
    </ThemeProvider>
  </StrictMode>
);

import { lazy, Suspense } from "react";
import { Outlet } from "react-router";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { ProcessingBlockerBanner } from "@/components/ProcessingBlockerBanner";
import { ProcessingQueueBanner } from "@/components/ProcessingQueueBanner";
import { GlobalDropOverlay } from "@/components/documents/GlobalDropOverlay";
import { UploadProvider } from "@/components/upload/UploadProvider";
import { Spinner } from "@/components/ui/spinner";

/**
 * Lazy on purpose, and this is load-bearing rather than a micro-optimisation.
 *
 * LandingPage imports DemoPanel, which reaches pdf.js through DemoPages — the
 * demo paints the visitor's own file before the server has done anything, which
 * requires pdf.js in the browser at drop time. A static import here would pull
 * that into this layout's chunk, and a layout's chunk is downloaded by every
 * route beneath it — so every signed-in page would ship the PDF engine twice
 * over. That is the 1.36 MB entry chunk this migration exists to break up.
 *
 * The signed-in viewer reaches pdf.js through its own route module, so both
 * paths load it on demand and share one chunk.
 */
const LandingPage = lazy(() => import("@/pages/LandingPage"));

/**
 * The auth branch, which framework mode cannot express as routes.
 *
 * App.tsx used two <Routes> trees with overlapping paths. A route table is
 * static, so the branch moves here: signed out, *any* path renders the landing
 * page with the URL left alone — a deep link does not survive the round trip,
 * exactly as before. Signed in, the matched route renders.
 *
 * Being the common parent of both the footer shell and the viewer is also
 * deliberate: it keeps UploadProvider mounted across a navigation into and out
 * of a document, which is where in-flight upload state used to live.
 */
export default function AuthGate() {
  return (
    <>
      {/* Not garnish: without this branch the signed-out tree renders for a
          beat on every reload, and a logged-in user watches the landing page
          flash before their projects. */}
      <AuthLoading>
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </AuthLoading>

      <Unauthenticated>
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <LandingPage />
        </Suspense>
      </Unauthenticated>

      {/* UploadProvider and the three banners/overlays below all read gated
          queries, so they live inside this boundary — mounted signed-out they
          fire five queries that throw before anything paints. */}
      <Authenticated>
        <UploadProvider>
          <ProcessingBlockerBanner />
          <ProcessingQueueBanner />
          <GlobalDropOverlay />
          <Outlet />
        </UploadProvider>
      </Authenticated>
    </>
  );
}

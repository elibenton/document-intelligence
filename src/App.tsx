import { Routes, Route, Outlet, Navigate } from "react-router";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import LandingPage from "./pages/LandingPage";
import SignInPage from "./pages/SignInPage";
import SignUpPage from "./pages/SignUpPage";
import ProjectsPage from "./pages/ProjectsPage";
import HomePage from "./pages/HomePage";
import DocumentPage from "./pages/DocumentPage";
import EntityPage from "./pages/EntityPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import AdminPage from "./pages/AdminPage";
import ProjectSettingsPage from "./pages/ProjectSettingsPage";
import { BudgetBanner } from "./components/BudgetBanner";
import { ProcessingBlockerBanner } from "./components/ProcessingBlockerBanner";
import { ProcessingQueueBanner } from "./components/ProcessingQueueBanner";
import { SiteFooter } from "./components/SiteFooter";
import { GlobalDropOverlay } from "./components/documents/GlobalDropOverlay";
import { UploadProvider } from "@/components/upload/UploadProvider";
import { Spinner } from "@/components/ui/spinner";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";

/** Every page but the document viewer sits in this shell. */
function PageWithFooter() {
  return (
    <>
      <div className="flex-1">
        <Outlet />
      </div>
      <SiteFooter />
    </>
  );
}

export default function App() {
  return (
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
            {/* Not garnish: without this branch the signed-out tree renders for
                a beat on every reload, and a logged-in user watches the landing
                page flash before their projects. */}
            <AuthLoading>
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            </AuthLoading>

            <Unauthenticated>
              <Routes>
                <Route path="/signin" element={<SignInPage />} />
                <Route path="/signup" element={<SignUpPage />} />
                {/* Every other path, signed out, is the front door. A deep
                    link does not survive the round trip — worth revisiting
                    when someone actually shares one. */}
                <Route path="*" element={<LandingPage />} />
              </Routes>
            </Unauthenticated>

            {/* UploadProvider and the three banners/overlays below all read
                gated queries, so they live inside this boundary rather than
                above <Routes> where they used to sit — mounted signed-out they
                fire five queries that throw before anything paints. Keeping
                them here, above <Routes>, also keeps upload state alive across
                navigations, including in and out of the viewer. */}
            <Authenticated>
              <UploadProvider>
                <BudgetBanner />
                <ProcessingBlockerBanner />
                <ProcessingQueueBanner />
                <GlobalDropOverlay />
                <Routes>
                  <Route element={<PageWithFooter />}>
                    <Route path="/" element={<ProjectsPage />} />
                    <Route path="/p/:slug" element={<HomePage />} />
                    <Route
                      path="/p/:slug/settings"
                      element={<ProjectSettingsPage />}
                    />
                    <Route path="/entity/:slug" element={<EntityPage />} />
                    <Route path="/search" element={<SearchPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    {/* Gated on the server by adminQuery, not by this route.
                        A non-admin who types the URL gets a thrown error, which
                        is the correct outcome. */}
                    <Route path="/admin" element={<AdminPage />} />
                  </Route>
                  {/* The document viewer is a fixed-height workspace of its
                      own, so it sits outside that shell and gets no footer. */}
                  <Route
                    path="/documents/:id"
                    element={
                      <main id="main" className="flex-1 min-h-0">
                        <DocumentPage />
                      </main>
                    }
                  />
                  {/* Already signed in: the two auth routes are just home. */}
                  <Route
                    path="/signin"
                    element={<Navigate to="/" replace />}
                  />
                  <Route
                    path="/signup"
                    element={<Navigate to="/" replace />}
                  />
                </Routes>
              </UploadProvider>
            </Authenticated>
          </div>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}

import { Routes, Route, Outlet } from "react-router";
import ProjectsPage from "./pages/ProjectsPage";
import HomePage from "./pages/HomePage";
import DocumentPage from "./pages/DocumentPage";
import EntityPage from "./pages/EntityPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import { ProcessingBlockerBanner } from "./components/ProcessingBlockerBanner";
import { ProcessingQueueBanner } from "./components/ProcessingQueueBanner";
import { SiteFooter } from "./components/SiteFooter";
import { GlobalDropOverlay } from "./components/documents/GlobalDropOverlay";
import { UploadProvider } from "@/components/upload/UploadProvider";
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

function App() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          <UploadProvider>
            {/* Every page's own <main> carries id="main"; the pages built on
                PageShell get it for free. */}
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[200] focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg focus:outline-none focus:ring-3 focus:ring-ring"
            >
              Skip to content
            </a>
            <div className="min-h-screen flex flex-col bg-background text-foreground max-w-[1800px] mx-auto border-x border-border">
              <ProcessingBlockerBanner />
              <ProcessingQueueBanner />
              <GlobalDropOverlay />
              <Routes>
                <Route element={<PageWithFooter />}>
                  <Route path="/" element={<ProjectsPage />} />
                  <Route path="/p/:slug" element={<HomePage />} />
                  <Route path="/entity/:slug" element={<EntityPage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Route>
                {/* The document viewer is a fixed-height workspace of its own,
                    so it sits outside that shell and gets no footer. */}
                <Route
                  path="/documents/:id"
                  element={
                    <main id="main" className="flex-1 min-h-0">
                      <DocumentPage />
                    </main>
                  }
                />
              </Routes>
            </div>
          </UploadProvider>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}

export default App;

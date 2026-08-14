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
    <UploadProvider>
      <div className="min-h-screen flex flex-col bg-background text-foreground max-w-[1800px] mx-auto border-x">
        <ProcessingBlockerBanner />
        <ProcessingQueueBanner />
        <GlobalDropOverlay />
        <Routes>
          <Route element={<PageWithFooter />}>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/p/:projectId" element={<HomePage />} />
            <Route path="/entity/:slug" element={<EntityPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          {/* The document viewer is a fixed-height workspace of its own, so it
              sits outside that shell and gets no footer. */}
          <Route
            path="/documents/:id"
            element={
              <div className="flex-1">
                <DocumentPage />
              </div>
            }
          />
        </Routes>
      </div>
    </UploadProvider>
  );
}

export default App;

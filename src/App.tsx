import { Routes, Route, useLocation } from "react-router-dom";
import ProjectsPage from "./pages/ProjectsPage";
import HomePage from "./pages/HomePage";
import DocumentPage from "./pages/DocumentPage";
import EntityPage from "./pages/EntityPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
// Prototype route, not linked from the UI — remove with the viewer decision.
import ViewerPrototypePage from "./pages/ViewerPrototypePage";
import { ProcessingBlockerBanner } from "./components/ProcessingBlockerBanner";
import { ProcessingQueueBanner } from "./components/ProcessingQueueBanner";
import { SiteFooter } from "./components/SiteFooter";
import { GlobalDropOverlay } from "./components/documents/GlobalDropOverlay";

function App() {
  const location = useLocation();
  // The document viewer is a fixed-height workspace, so it gets no footer.
  const showFooter = !location.pathname.startsWith("/documents/");

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground max-w-[1800px] mx-auto border-x">
      <ProcessingBlockerBanner />
      <ProcessingQueueBanner />
      <GlobalDropOverlay />
      <div className="flex-1">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/p/:projectId" element={<HomePage />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
          <Route path="/entity/:slug" element={<EntityPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/prototype/viewer/:id" element={<ViewerPrototypePage />} />
        </Routes>
      </div>
      {showFooter && <SiteFooter />}
    </div>
  );
}

export default App;

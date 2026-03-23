import { Routes, Route } from "react-router-dom";
import HomePage from "./pages/HomePage";
import DocumentPage from "./pages/DocumentPage";
import StoryPage from "./pages/StoryPage";
import EntityPage from "./pages/EntityPage";

function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/documents/:id" element={<DocumentPage />} />
        <Route path="/story/:slug" element={<StoryPage />} />
        <Route path="/entity/:slug" element={<EntityPage />} />
      </Routes>
    </div>
  );
}

export default App;

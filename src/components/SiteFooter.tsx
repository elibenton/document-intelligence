import { Link } from "react-router-dom";
import { FileText, Settings as SettingsIcon } from "lucide-react";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * Global site footer: branding on the left, settings (theme + a link to the
 * Settings page) on the right. Rendered once in App, in normal document flow
 * at the end of the page.
 */
export function SiteFooter() {
  return (
    <footer className="border-t px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
      {/* Branding */}
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="leading-tight">
          <p className="font-semibold">Document Intelligence</p>
          <p className="text-xs text-muted-foreground">
            Turn documents into entities, connections, and answers.
          </p>
        </div>
      </div>

      {/* Settings */}
      <div className="flex items-center gap-1">
        <Link
          to="/settings"
          title="Settings & usage"
          className="flex items-center gap-1.5 px-2 py-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        >
          <SettingsIcon className="h-4 w-4 shrink-0" />
          <span>Settings</span>
        </Link>
        <ThemeToggle />
      </div>
    </footer>
  );
}

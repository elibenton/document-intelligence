import { Link, useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { LogOut, Settings as SettingsIcon } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { authClient } from "@/lib/auth-client";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * Global site footer: branding on the left, settings (theme, a link to the
 * Settings page, sign out) on the right. Rendered once in App, in normal
 * document flow at the end of the page.
 *
 * Sign-out lives here rather than in a user menu because there is no global
 * header to hang one on — this footer is the only chrome every signed-in page
 * shares.
 */
export function SiteFooter() {
  const navigate = useNavigate();
  // The component's own "who am I" query, re-exported from convex/auth.ts.
  // Better Auth's `authClient.useSession()` would also answer, but that would
  // be a second source of truth for the same fact, on a different transport.
  // `undefined` here is the in-flight state, not a signed-out one — the footer
  // only ever renders inside <Authenticated>.
  const user = useQuery(api.auth.getAuthUser);
  return (
    <footer className="border-t px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
      {/* Branding */}
      <div className="flex items-center gap-2">
        {/* Black line art, so it needs inverting to stay visible in dark. */}
        <img
          src="/haystack.png"
          alt=""
          className="size-5 shrink-0 object-contain dark:invert"
        />
        <div className="leading-tight">
          <p className="font-semibold">Haystack</p>
          <p className="text-xs text-muted-foreground">
            Throw anything in. Get answers out.
          </p>
        </div>
      </div>

      {/* Settings */}
      <div className="flex items-center gap-1">
        {/* Reserve the row height while the name is in flight, so the footer
            controls don't jump once it lands. */}
        <span className="px-2 text-muted-foreground">
          {user ? `Hello, ${user.name || user.email}` : " "}
        </span>
        <Link
          to="/settings"
          title="Settings & usage"
          className="flex items-center gap-1.5 px-2 py-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        >
          <SettingsIcon className="size-4 shrink-0" />
          <span>Settings</span>
        </Link>
        <button
          type="button"
          title="Sign out"
          onClick={async () => {
            await authClient.signOut();
            void navigate("/");
          }}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <LogOut className="size-4 shrink-0" />
          <span>Sign out</span>
        </button>
        <ThemeToggle />
      </div>
    </footer>
  );
}

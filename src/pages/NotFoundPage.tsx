import { Link } from "react-router";
import { PageShell } from "@/components/ui/page-shell";
import { buttonVariants } from "@/components/ui/button-variants";

/**
 * Signed in, an unmatched path used to match nothing and paint an empty shell,
 * because App.tsx's authenticated <Routes> had no catch-all. Signed out this
 * never renders: AuthGate paints the landing page for every path.
 */
export default function NotFoundPage() {
  return (
    <PageShell
      title="Not found"
      subtitle="That address does not point at anything here."
      width="prose"
    >
      <Link to="/" className={buttonVariants()}>
        Back to projects
      </Link>
    </PageShell>
  );
}

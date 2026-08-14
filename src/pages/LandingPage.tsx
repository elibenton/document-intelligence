import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button-variants";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * The only page an unauthenticated visitor ever reaches, and so also what a
 * link preview or a crawler sees. It carries its own header because there is no
 * shared one — the signed-in pages each build their own on PageShell, and
 * giving all six a global top bar is a design change auth does not need.
 *
 * Deliberately thin. This is a door, not a marketing site.
 */
export default function LandingPage() {
  return (
    <>
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          {/* Black line art, so it needs inverting to stay visible in dark. */}
          <img
            src="/haystack.png"
            alt=""
            className="size-5 shrink-0 object-contain dark:invert"
          />
          <span className="font-semibold">Haystack</span>
        </div>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          {/* Styled Links, not Buttons: these navigate, so they should keep
              link semantics. Button-rendered-as-Link stamps role="button" on
              the anchor. Same idiom as ProcessingBlockerBanner. */}
          <Link
            to="/signin"
            className={buttonVariants({ variant: "ghost" })}
          >
            Log in
          </Link>
          <Link to="/signup" className={buttonVariants()}>
            Sign up
          </Link>
        </div>
      </header>

      <main
        id="main"
        className="flex flex-1 items-center justify-center px-6 py-24"
      >
        <div className="max-w-xl text-center">
          <h1 className="text-3xl font-semibold text-balance">
            Anything in. Answers out.
          </h1>
          <p className="mt-4 text-base text-muted-foreground text-balance">
            Upload PDFs, CSVs, images, and recordings — every source parsed,
            entities and relationships extracted, answers cited back to the
            page.
          </p>
          <div className="mt-8 flex items-center justify-center gap-2">
            <Link to="/signup" className={buttonVariants({ size: "lg" })}>
              Get started
            </Link>
            <Link
              to="/signin"
              className={buttonVariants({ size: "lg", variant: "outline" })}
            >
              Log in
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}

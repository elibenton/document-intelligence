import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button-variants";
import { DemoPanel } from "@/components/landing/DemoPanel";

/**
 * The only page an unauthenticated visitor ever reaches, and so also what a
 * link preview or a crawler sees. It carries its own header because there is no
 * shared one — the signed-in pages each build their own on PageShell, and
 * giving all six a global top bar is a design change auth does not need.
 *
 * No longer only a door: the demo panel runs the real pipeline on a visitor's
 * own file. The header is therefore stripped back to the controls that have to
 * be reachable from anywhere (theme, log in, sign up), and the identity — mark
 * and name — moves into the centre of the page above the thing it is asking to
 * be trusted with a document.
 */
export default function LandingPage() {
  return (
    <>
      <header className="flex items-center justify-end gap-1 px-6 py-4">
        {/* Styled Links, not Buttons: these navigate, so they should keep
            link semantics. Button-rendered-as-Link stamps role="button" on
            the anchor. Same idiom as ProcessingBlockerBanner. */}
        <Link to="/signin" className={buttonVariants({ variant: "ghost" })}>
          Log in
        </Link>
        <Link to="/signup" className={buttonVariants()}>
          Sign up
        </Link>
      </header>

      <main
        id="main"
        className="flex flex-1 flex-col items-center px-6 pb-24 pt-10"
      >
        <div className="flex w-full max-w-3xl flex-col items-center text-center">
          {/* The lockup: mark and name on one line, centred. The name is the
              page's <h1> — the tagline below it reads as the heading but is
              the product's claim, not its identity, and a crawler or a screen
              reader should meet the name first. Black line art, so it needs
              inverting to stay visible in dark. */}
          <div className="flex items-center gap-4">
            <img
              src="/haystack.png"
              alt=""
              className="size-20 shrink-0 object-contain dark:invert sm:size-24"
            />
            <h1 className="text-4xl font-semibold">Haystack</h1>
          </div>

          <p className="mt-8 text-2xl font-semibold text-balance">
            Throw anything in. Get answers out.
          </p>
        </div>

        {/* The only call to action on the page below the header. The pair of
            Get started / Log in buttons that used to sit under this was the
            same offer the header already makes, and the demo makes it again
            on its own terms once a document has actually been read.

            Deliberately outside the max-w-3xl column that holds the copy: once
            a document is on screen the panel is two panes side by side, and
            three columns of prose is the wrong width for that. It sets its own
            width per state.

            The line of body copy that used to sit above this — what Haystack
            takes and what it gives back — moved *into* the panel, because it
            shares its slot with the pipeline's progress and only the panel
            knows which of the two belongs there. */}
        <div className="mt-4 w-full">
          <DemoPanel />
        </div>
      </main>
    </>
  );
}

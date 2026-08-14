import { useCallback, useEffect, useRef, useState } from "react";
import { ConvexError } from "convex/values";
import { ConvexProvider, useConvex } from "convex/react";
import { Link } from "react-router";
import { AlertCircle, UploadCloud } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { buttonVariants } from "@/components/ui/button-variants";
import { Spinner } from "@/components/ui/spinner";
import { isPdfUpload, preflightPdf } from "@/lib/pdfPreflight";
import { formatBytes } from "@/lib/formatBytes";
import { BUILD_SHA } from "@/lib/reportIssue";
import {
  clearDemoToken,
  storeDemoToken,
  storedDemoToken,
} from "@/lib/demoSession";
import { demoConvexClient } from "@/lib/demoConvexClient";
import { DEMO_MAX_BYTES, DEMO_MAX_PAGES } from "../../../convex/demoLimits";
import { DemoPages } from "./DemoPages";
import { DemoStages } from "./DemoStages";
import { DemoResults } from "./DemoResults";

/**
 * The landing page's try-it-out panel: drop one PDF, see it open, watch it get
 * read.
 *
 * ## The viewer comes first, and everything else happens beside it
 *
 * This is the whole point of the panel, and the first version got it backwards.
 * It ran `preflightPdf` — which parses the entire file with pdf.js — and then
 * an upload round trip, and only *then* showed the document. A visitor dropped
 * a file and watched a spinner for several seconds, and if anything was wrong
 * the panel was replaced by an error: the document viewer, the one thing the
 * demo exists to show, never appeared at all.
 *
 * So the order is now: paint the document, then do the work. `DemoPages` draws
 * from the visitor's own copy of the file and waits on nothing, so pages are on
 * screen in the time pdf.js takes to parse them. Checking, uploading and the
 * pipeline's own progress all report into the panel *next to* the pages.
 *
 * The consequence worth stating: only a file that cannot be displayed at all
 * (not a PDF, too large, encrypted, corrupt) replaces the panel. Everything
 * else keeps the viewer and explains itself alongside it.
 *
 * There is deliberately no scanned-document check. The parse stage runs
 * Interfaze's OCR task, and scans read correctly — the corpus's most
 * unambiguous one returns 7,769 characters. The gate that used to be here was
 * refusing exactly the documents this demo exists to impress people with.
 *
 * ## Why the session is minted on drop, not on mount
 *
 * `demo.startSession` is rate-limited deployment-wide, so a session issued to
 * every visitor who merely *loads* the page would spend that allowance on
 * people who never drop anything. Nothing is created until there is a file.
 *
 * ## What the checks here are and are not
 *
 * Everything refused below is refused again on the server (convex/demo.ts).
 * These exist to fail fast and kindly, not to be the protection. The limits
 * come from convex/demoLimits.ts so the number in the message and the number
 * in the enforcement are the same one.
 */

/** What the pipeline side of the panel is doing, once a file is on screen. */
type Phase =
  | { kind: "checking" }
  /** Readable, uploaded, and now the server's to report on. */
  | { kind: "live"; sessionToken: string }
  /**
   * Shown, but not run through the pipeline — currently only a document longer
   * than the demo reads. The viewer keeps the first DEMO_MAX_PAGES pages, which
   * is a better answer than a refusal: the visitor still sees their own document
   * open, and the reason they are not getting answers for it is a limit rather
   * than a failure.
   */
  | { kind: "unreadable"; message: string }
  | { kind: "failed"; message: string };

type State =
  | { kind: "idle" }
  /** A file that cannot be shown at all; the only case that replaces the panel. */
  | { kind: "rejected"; message: string }
  /**
   * `url` is the blob URL DemoPages draws from. It is minted in the handler
   * that receives the file and revoked when the panel is reset, so exactly one
   * exists per selection — see the note in DemoPages on why creating it during
   * render or in an effect does not survive StrictMode.
   */
  | { kind: "active"; file: File; url: string; phase: Phase }
  /** Restored from a stored token; the file itself is gone with the page load. */
  | { kind: "restored"; sessionToken: string };

/** A ConvexError's `data` carries the demo's refusal codes; anything else is a bug. */
function messageFor(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    if (typeof data === "object" && data?.message) return data.message;
  }
  return "Something went wrong starting the demo. Please try again.";
}

/**
 * Runs the panel against the demo's own Convex client rather than the app's.
 *
 * The app's client is built with `expectAuth: true`, which queues every request
 * until a session resolves — so from a signed-out visitor nothing ever reached
 * the deployment and the panel hung indefinitely. See src/lib/demoConvexClient.
 */
export function DemoPanel() {
  return (
    <ConvexProvider client={demoConvexClient()}>
      <DemoPanelInner />
    </ConvexProvider>
  );
}

function DemoPanelInner() {
  const convex = useConvex();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // A stored token means this browser already used its one file. Restore the
  // results rather than offering a dropzone the server would refuse.
  useEffect(() => {
    const token = storedDemoToken();
    // Only from idle. A file dropped before this effect ran would otherwise be
    // replaced by the restored view a beat later — the document already on
    // screen swapped for "the pages aren't here after a reload". Narrow, but it
    // showed up the first time a drop was scripted immediately after load.
    if (token) {
      setState((prev) =>
        prev.kind === "idle" ? { kind: "restored", sessionToken: token } : prev
      );
    }
  }, []);

  const start = useCallback(
    async (file: File) => {
      // The two things knowable without parsing anything, so they can still be
      // decided before the viewer is committed to.
      if (!isPdfUpload(file)) {
        setState({
          kind: "rejected",
          message:
            "The demo reads PDFs. Sign up to throw in spreadsheets, images and recordings too.",
        });
        return;
      }
      if (file.size > DEMO_MAX_BYTES) {
        setState({
          kind: "rejected",
          message: `That file is ${formatBytes(file.size)}. The demo takes up to ${formatBytes(
            DEMO_MAX_BYTES
          )} — sign up to upload larger ones.`,
        });
        return;
      }

      // From here the document is on screen. Every later outcome updates the
      // phase beside it rather than replacing it.
      setState({
        kind: "active",
        file,
        url: URL.createObjectURL(file),
        phase: { kind: "checking" },
      });
      const setPhase = (phase: Phase) =>
        setState((prev) =>
          // Ignore a result that lands after the visitor moved on.
          prev.kind === "active" && prev.file === file ? { ...prev, phase } : prev
        );

      const preflight = await preflightPdf(file);
      if (!preflight.ok) {
        // Password-protected, corrupt, or not really a PDF: pdf.js cannot open
        // it either, so there is no viewer to keep — and the URL minted for one
        // goes with it.
        setState((prev) => {
          if (prev.kind === "active") URL.revokeObjectURL(prev.url);
          return { kind: "rejected", message: preflight.message };
        });
        return;
      }
      if (preflight.pageCount > DEMO_MAX_PAGES) {
        setPhase({
          kind: "unreadable",
          message: `This is a ${preflight.pageCount}-page document, and the demo reads up to ${DEMO_MAX_PAGES}. The first ${DEMO_MAX_PAGES} are shown here — sign up for a free account to read the whole thing.`,
        });
        return;
      }
      // No text-layer gate. A scan is a first-class document here: the parse
      // stage runs Interfaze's OCR task, and the corpus's most unambiguous
      // scan — no text layer, no embedded fonts, five camera JPEGs — reads back
      // 7,769 characters. Turning those away was the demo refusing to do the
      // thing it exists to demonstrate.
      // Hoisted out of the try so the catch can report against the session that
      // was minted before the failure. Undefined means startSession itself
      // threw, and there is no gated endpoint to report through.
      let sessionToken: string | undefined;
      try {
        ({ sessionToken } = await convex.mutation(api.demo.startSession, {}));
        const uploadUrl = await convex.mutation(api.demo.generateUploadUrl, {
          sessionToken,
        });
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/pdf" },
          body: file,
        });
        if (!response.ok) throw new Error("Upload failed");
        const { storageId } = (await response.json()) as {
          storageId: Id<"_storage">;
        };
        await convex.mutation(api.demo.createDocument, {
          sessionToken,
          name: file.name,
          storageId,
        });
        storeDemoToken(sessionToken);
        setPhase({ kind: "live", sessionToken });
      } catch (error) {
        const message = messageFor(error);
        setPhase({ kind: "failed", message });
        // Best-effort, and only reachable once `sessionToken` exists — see the
        // note on convex/demo.ts `reportIssue` for the four earlier rejections
        // that deliberately cannot report.
        if (!sessionToken) return;
        void convex
          .mutation(api.demo.reportIssue, {
            sessionToken,
            surface: "client",
            stage: "upload",
            message,
            errorCode: error instanceof Error ? error.name : undefined,
            fileKind: "pdf",
            sizeBytes: file.size,
            pageCount: preflight.pageCount,
            mimeType: file.type || undefined,
            buildSha: BUILD_SHA,
          })
          .catch(() => {});
      }
    },
    [convex]
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file) void start(file);
    },
    [start]
  );

  const reset = useCallback(() => {
    // A refused token is the one thing that must not be left behind: an expired
    // session would otherwise make this panel permanently unusable here.
    clearDemoToken();
    setState((prev) => {
      if (prev.kind === "active") URL.revokeObjectURL(prev.url);
      return { kind: "idle" };
    });
  }, []);

  // The session to watch, once there is one. Before it exists the stage strip
  // still draws: step one is genuinely underway while the file is being checked
  // and uploaded, and there is nothing to ask the server about yet.
  const sessionToken =
    state.kind === "restored"
      ? state.sessionToken
      : state.kind === "active" && state.phase.kind === "live"
        ? state.phase.sessionToken
        : undefined;

  // The stages take the headline's place from the moment a document is on
  // screen, and only while it is on its way to an answer. A file we could not
  // show, or could show but will not read, puts the claim back — there are no
  // stages to run for it.
  const showStages =
    state.kind === "restored" ||
    (state.kind === "active" &&
      (state.phase.kind === "checking" || state.phase.kind === "live"));

  const body = ((): React.ReactNode => {
  // ---- a document is on screen --------------------------------------------

  if (state.kind === "active" || state.kind === "restored") {
    return (
      // Wider than the page's prose column: this is the one state that is two
      // panes at once, and at 3xl each of them was too narrow to read — pages
      // shrunk to a thumbnail, results wrapping every other word.
      <div className="mx-auto w-full max-w-6xl overflow-hidden rounded-lg border bg-card text-left">
        <div className="grid md:grid-cols-2">
          <div className="max-h-[70vh] overflow-y-auto border-b md:border-b-0 md:border-r">
            {state.kind === "active" ? (
              <DemoPages url={state.url} />
            ) : (
              <p className="p-6 text-center text-sm text-muted-foreground text-balance">
                The file stays in the browser tab it was dropped into, so the
                pages aren't here after a reload — but what was read from it is.
              </p>
            )}
          </div>

          <div className="max-h-[70vh] overflow-y-auto">
            {state.kind === "restored" ? (
              <DemoResults sessionToken={state.sessionToken} />
            ) : state.phase.kind === "live" ? (
              <DemoResults sessionToken={state.phase.sessionToken} />
            ) : state.phase.kind === "checking" ? (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Spinner />
                Checking the document…
              </div>
            ) : (
              <div className="space-y-4 p-6">
                <div className="flex items-start gap-2 text-sm">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <p className="text-balance">{state.phase.message}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link to="/signup" className={buttonVariants()}>
                    Sign up — it's free
                  </Link>
                  <button
                    type="button"
                    onClick={reset}
                    className={buttonVariants({ variant: "outline" })}
                  >
                    Try another file
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---- nothing displayable ------------------------------------------------

  if (state.kind === "rejected") {
    return (
      <div className="mx-auto w-full max-w-3xl rounded-lg border border-destructive/40 bg-card p-6 text-center">
        <AlertCircle className="mx-auto mb-3 size-5 text-destructive" />
        <p className="mb-4 text-sm text-balance">{state.message}</p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className={buttonVariants({ variant: "outline" })}
          >
            Try another file
          </button>
          <Link to="/signup" className={buttonVariants()}>
            Sign up
          </Link>
        </div>
      </div>
    );
  }

  // ---- idle ---------------------------------------------------------------

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`mx-auto w-full max-w-3xl rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
        dragging ? "border-ring bg-accent/40" : "border-border"
      }`}
    >
      {/* `hidden`, not `sr-only`: sr-only keeps the input focusable, so Tab
          stopped on an invisible file picker with no focus ring before
          reaching the button that opens it. The button is the control; this is
          the mechanism. */}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file twice still fires a change event.
          event.target.value = "";
          if (file) void start(file);
        }}
      />

      <UploadCloud
        className="mx-auto mb-3 size-6 text-muted-foreground"
        aria-hidden="true"
      />
      <p className="mb-1 text-base">Drop a PDF to try it</p>
      <p className="mb-4 text-sm text-muted-foreground text-balance">
        One file, up to {DEMO_MAX_PAGES} pages. No account needed.
      </p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={buttonVariants({ variant: "outline" })}
      >
        Choose a file
      </button>
    </div>
  );
  })();

  return (
    <>
      {/* Both lines live in one grid cell, so they cross over in place rather
          than one collapsing and everything below jumping up a line. The motion
          is horizontal because they are two versions of the same single slot:
          the claim leaves to the left as the run of steps arrives from the
          right. Whichever is out is inert — no pointer events, out of the
          accessibility tree — so a screen reader reads one line, not both. */}
      <div className="mx-auto grid w-full max-w-3xl">
        <p
          aria-hidden={showStages}
          className={`col-start-1 row-start-1 mx-auto max-w-xl text-base text-muted-foreground text-balance transition-all duration-500 ease-out ${
            showStages
              ? "pointer-events-none -translate-x-6 opacity-0"
              : "translate-x-0 opacity-100"
          }`}
        >
          Upload PDFs, CSVs, images, and recordings — every source parsed,
          entities and relationships extracted, answers cited back to the page.
        </p>
        <div
          aria-hidden={!showStages}
          className={`col-start-1 row-start-1 self-center transition-all duration-500 ease-out ${
            showStages
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-6 opacity-0"
          }`}
        >
          <DemoStages sessionToken={sessionToken} />
        </div>
      </div>

      <div className="mt-10">{body}</div>
    </>
  );
}

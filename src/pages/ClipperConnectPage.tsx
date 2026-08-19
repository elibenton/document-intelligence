import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "react-router";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/ui/page-shell";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The landing page for the extension's "Sign in & connect" button.
 *
 * The extension opens this URL with its own id in `?ext=`; AuthGate has
 * already forced a sign-in by the time it renders. Connecting mints (or
 * reuses) the caller's clipper token and hands it to the extension over
 * `chrome.runtime.sendMessage` — the page-side API Chrome exposes to origins
 * the extension lists in `externally_connectable`. Nothing is pasted anywhere.
 */

/** What Chrome exposes to a page listed in the extension's externally_connectable. */
interface ExtensionMessenger {
  runtime?: {
    sendMessage: (
      extensionId: string,
      message: unknown,
      callback: (response?: { ok?: boolean; error?: string }) => void
    ) => void;
    lastError?: { message?: string };
  };
}

type Phase =
  | { phase: "idle" | "working" | "done" }
  | { phase: "error"; message: string };

export default function ClipperConnectPage() {
  const [params] = useSearchParams();
  const extensionId = params.get("ext");
  const token = useQuery(api.clipperTokens.mine);
  const projects = useQuery(api.projects.list);
  const mint = useMutation(api.clipperTokens.mint);
  const [projectDraft, setProjectDraft] = useState<Id<"projects"> | null>(null);
  const [state, setState] = useState<Phase>({ phase: "idle" });

  const selectedProject =
    projectDraft ?? token?.projectId ?? projects?.[0]?._id ?? null;

  async function connect() {
    if (!extensionId || !selectedProject || state.phase === "working") return;
    const messenger = (window as { chrome?: ExtensionMessenger }).chrome;
    if (!messenger?.runtime?.sendMessage) {
      setState({
        phase: "error",
        message:
          "This browser can't reach the extension. Open this page from the extension's options in the browser where it is installed.",
      });
      return;
    }
    setState({ phase: "working" });
    try {
      // Reuse the existing token when the project matches, so reconnecting a
      // second browser doesn't rotate the secret out from under the first.
      const tokenValue =
        token && token.projectId === selectedProject
          ? token.token
          : await mint({ projectId: selectedProject });
      const endpoint = (
        import.meta.env.VITE_CONVEX_SITE_URL as string
      ).replace(/\/+$/, "");
      messenger.runtime.sendMessage(
        extensionId,
        { type: "haystack-clipper-connect", endpoint, token: tokenValue },
        (response) => {
          if (messenger.runtime?.lastError || !response?.ok) {
            setState({
              phase: "error",
              message:
                response?.error ??
                messenger.runtime?.lastError?.message ??
                "The extension didn't respond. Start again from its options page.",
            });
          } else {
            setState({ phase: "done" });
          }
        }
      );
    } catch (e) {
      setState({
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <PageShell
      title="Connect the clipper"
      subtitle="Link the browser extension to your account. The project picked here is the default — the popup lets you choose per clip. Processing bills to you."
      width="prose"
    >
      {!extensionId ? (
        <p className="text-sm text-muted-foreground">
          This page is opened by the Haystack Clipper extension. Open the
          extension&rsquo;s options and choose &ldquo;Sign in &amp;
          connect&rdquo; to start.
        </p>
      ) : token === undefined || projects === undefined ? (
        <Skeleton className="h-24 w-full" />
      ) : state.phase === "done" ? (
        <p className="text-sm">
          <span className="font-medium text-success">Connected ✓</span> — the
          extension is ready. You can close this tab and clip any page from the
          toolbar.
        </p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Create a project first — clips need somewhere to land.
        </p>
      ) : (
        <div className="max-w-md">
          <label htmlFor="connect-project" className="text-sm font-medium">
            Default project
          </label>
          <div className="mt-2 flex items-center gap-2">
            <Select
              id="connect-project"
              value={selectedProject}
              onValueChange={setProjectDraft}
              items={projects.map((project) => ({
                value: project._id,
                label: project.name,
              }))}
              className="flex-1"
            />
            <Button
              size="sm"
              disabled={state.phase === "working"}
              onClick={() => void connect()}
            >
              {state.phase === "working" ? "Connecting…" : "Connect"}
            </Button>
          </div>
          {state.phase === "error" && (
            <p className="mt-2 text-xs text-destructive">{state.message}</p>
          )}
        </div>
      )}
    </PageShell>
  );
}

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Scissors } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The personal web-clipper connection: which owned project clips land in, and
 * the kill switch. The extension gets its token by opening /clipper/connect
 * from its own options page — nothing is displayed or pasted here. The project
 * choice lives on the token server-side (convex/clipperTokens.ts); changing it
 * or revoking rotates/retires the secret, which disconnects any connected
 * extension until it reconnects.
 */
export default function ClipperTokenSettings() {
  const token = useQuery(api.clipperTokens.mine);
  const projects = useQuery(api.projects.list);
  const mint = useMutation(api.clipperTokens.mint);
  const revoke = useMutation(api.clipperTokens.revoke);
  const [projectDraft, setProjectDraft] = useState<Id<"projects"> | null>(null);
  const [working, setWorking] = useState(false);

  if (token === undefined || projects === undefined) {
    return <Skeleton className="h-24 w-full" />;
  }

  const selectedProject =
    projectDraft ?? token?.projectId ?? projects[0]?._id ?? null;

  async function run(action: () => Promise<unknown>) {
    if (working) return;
    setWorking(true);
    try {
      await action();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4 mb-8">
      <div className="flex items-start gap-3">
        <Scissors className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <label htmlFor="clipper-project" className="text-sm font-medium">
            Browser extension
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Connect from the extension&rsquo;s options page — it signs you in
            here and picks up its token automatically. Clips land in the
            project chosen below, and their processing bills to your account.
            Changing the project or revoking disconnects the extension until
            you reconnect it.
          </p>
          {projects.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Create a project first — clips need somewhere to land.
            </p>
          ) : (
            <>
              <div className="mt-3 flex max-w-md items-center gap-2">
                <select
                  id="clipper-project"
                  value={selectedProject ?? ""}
                  onChange={(event) =>
                    setProjectDraft(event.target.value as Id<"projects">)
                  }
                  className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/30"
                >
                  {projects.map((project) => (
                    <option key={project._id} value={project._id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                {token && (
                  <Button
                    size="sm"
                    disabled={working || selectedProject === token.projectId}
                    onClick={() =>
                      void run(() => mint({ projectId: selectedProject! }))
                    }
                  >
                    Move clips here
                  </Button>
                )}
                {token && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={working}
                    onClick={() => void run(() => revoke())}
                  >
                    Revoke
                  </Button>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {token
                  ? `Connected since ${new Date(token.createdAt).toLocaleDateString()}.`
                  : "Not connected yet."}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

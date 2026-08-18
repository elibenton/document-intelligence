import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Scissors } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The personal web-clipper token: mint it, reveal it, revoke it, and pick
 * which owned project clips land in. The project choice lives on the token
 * server-side (convex/clipperTokens.ts), so the extension itself only ever
 * holds the token — regenerating always rotates the secret, which is also how
 * a leaked one is retired.
 */
export default function ClipperTokenSettings() {
  const token = useQuery(api.clipperTokens.mine);
  const projects = useQuery(api.projects.list);
  const mint = useMutation(api.clipperTokens.mint);
  const revoke = useMutation(api.clipperTokens.revoke);
  const [projectDraft, setProjectDraft] = useState<Id<"projects"> | null>(null);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);

  if (token === undefined || projects === undefined) {
    return <Skeleton className="h-24 w-full" />;
  }

  const selectedProject =
    projectDraft ?? token?.projectId ?? projects[0]?._id ?? null;

  async function generate() {
    if (!selectedProject || working) return;
    setWorking(true);
    try {
      await mint({ projectId: selectedProject });
    } finally {
      setWorking(false);
    }
  }

  async function copyToken() {
    if (!token) return;
    await navigator.clipboard.writeText(token.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border bg-card p-4 mb-8">
      <div className="flex items-start gap-3">
        <Scissors className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <label htmlFor="clipper-project" className="text-sm font-medium">
            Personal clipper token
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Paste this token into the browser extension&rsquo;s settings. Clips
            land in the project chosen here, and their processing bills to your
            account. Regenerating invalidates the old token.
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
                <Button size="sm" disabled={working} onClick={() => void generate()}>
                  {working ? "Working…" : token ? "Regenerate" : "Generate token"}
                </Button>
              </div>
              {token && (
                <div className="mt-2 flex max-w-md items-center gap-2">
                  <Input
                    readOnly
                    aria-label="Clipper token"
                    value={token.token}
                    onFocus={(event) => event.target.select()}
                    className="h-9 flex-1 font-mono text-xs md:text-xs"
                  />
                  <Button size="sm" variant="outline" onClick={() => void copyToken()}>
                    {copied ? "Copied ✓" : "Copy"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={working}
                    onClick={() => void revoke()}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

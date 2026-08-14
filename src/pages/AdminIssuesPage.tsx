import { useState } from "react";
import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import { buttonVariants } from "@/components/ui/button-variants";
import type { Route } from "./+types/AdminIssuesPage";
import { PageShell, SectionHeading } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The triage queue: every distinct failure in the app, ranked by how many
 * people it happened to.
 *
 * A route of its own rather than a section of AdminPage, for the reason that
 * page gives for being a route of its own — it is specifically about spend,
 * down to its subtitle and its ErrorBoundary's reasoning about `admin.usage`.
 * A list of what is broken is a different question with a different answer.
 *
 * Ordering is done on the server (convex/issues.ts `list`) so that what the
 * triage agent reads and what is shown here cannot disagree about which problem
 * is worst.
 */

/** Same shape as AdminPage's: the admin refusal stays a refusal. */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = error instanceof Error ? error.message : String(error);
  const refused = message.includes("Not authorized");

  return (
    <PageShell
      title={refused ? "Not your dashboard" : "Something went wrong"}
      subtitle={
        refused
          ? "Failure triage is visible to the account that owns the deployment."
          : message
      }
      width="prose"
    >
      <Link to="/" className={buttonVariants()}>
        Back to projects
      </Link>
    </PageShell>
  );
}

const STATES = ["open", "triaged", "resolved", "ignored"] as const;

const SURFACE_LABEL: Record<string, string> = {
  client: "Browser",
  pipeline: "Pipeline",
  render: "Render",
  provider: "Provider",
  crash: "Crash",
};

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function AdminIssuesPage() {
  const [state, setState] = useState<(typeof STATES)[number]>("open");
  const issues = useQuery(api.issues.list, { state });

  return (
    <PageShell
      title="Failures"
      subtitle="Every distinct failure, grouped and counted. Worst first."
      back={{ to: "/admin", label: "Back to usage" }}
      actions={
        <div className="flex items-center gap-1">
          {STATES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === state ? "secondary" : "ghost"}
              aria-pressed={s === state}
              onClick={() => setState(s)}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </Button>
          ))}
        </div>
      }
    >
      {issues === undefined ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      ) : issues.length === 0 ? (
        <EmptyState
          title={`Nothing ${state}`}
          description={
            state === "open"
              ? "No failures are waiting for triage."
              : `No issues are marked ${state}.`
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          <section>
            <SectionHeading>
              {issues.length} {state} {issues.length === 1 ? "issue" : "issues"}
            </SectionHeading>
            <p className="text-xs text-muted-foreground mb-3">
              Ranked by accounts affected, then by how often. One account failing
              fifty times and fifty accounts failing once are different problems.
            </p>
            <ul className="flex flex-col gap-3">
              {issues.map((issue) => (
                <li
                  key={issue._id}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          {SURFACE_LABEL[issue.surface] ?? issue.surface}
                        </span>
                        <span>{issue.stage}</span>
                        {issue.errorCode && (
                          <span className="text-destructive">
                            {issue.errorCode}
                          </span>
                        )}
                        {issue.fileKind && <span>{issue.fileKind}</span>}
                        {issue.regressedAt && (
                          <span className="text-warning">regressed</span>
                        )}
                      </div>
                      <p className="mt-1 text-sm break-words">{issue.title}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-lg tabular-nums">
                        {issue.affectedOwners}
                        {issue.ownersTruncated && "+"}
                      </div>
                      <div className="text-2xs text-muted-foreground">
                        {issue.affectedOwners === 1 ? "account" : "accounts"}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground tabular-nums">
                    <span>{issue.count.toLocaleString()}×</span>
                    <span>first {ago(issue.firstSeenAt)}</span>
                    <span>last {ago(issue.lastSeenAt)}</span>
                    {issue.lastBuildSha && (
                      <span>build {issue.lastBuildSha}</span>
                    )}
                  </div>

                  {issue.triage && (
                    // Written by the triage agent (.claude/commands/triage.md),
                    // deliberately as plain text rather than rendered markdown:
                    // this is a report the owner reads, and pulling in a
                    // markdown renderer to bold a few headings is not worth the
                    // bundle.
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        Triage report · {ago(issue.triage.at)} · at{" "}
                        {issue.triage.atCount}×
                      </summary>
                      <pre className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                        {issue.triage.markdown}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </PageShell>
  );
}

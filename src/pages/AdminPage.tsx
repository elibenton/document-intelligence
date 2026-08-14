import { useState } from "react";
import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import { buttonVariants } from "@/components/ui/button-variants";
import type { Route } from "./+types/AdminPage";
import { PageShell, SectionHeading } from "@/components/ui/page-shell";
import { StatCard } from "@/components/settings/StatCard";
import { AccountLimitCell } from "@/components/settings/AccountLimitCell";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Deployment spend, for the owner.
 *
 * A route of its own rather than a section of SettingsPage, and the reason is
 * enforcement rather than layout: on a shared page `admin.usage` would have to
 * return null for non-admins instead of throwing, because a thrown useQuery
 * breaks the whole page for everyone. Softening the refusal to keep a page from
 * breaking is how a boundary rots. Here it can throw.
 */

/**
 * Where that throw lands.
 *
 * Without this the refusal takes the whole app down to React Router's default
 * error screen, which is why a shared page would have been tempted to soften
 * `admin.usage` into returning null. Scoped to this route, the refusal stays a
 * refusal and costs nothing but this page.
 *
 * "Not authorized" is the ConvexError `adminOnly` throws (convex/authz.ts:115);
 * anything else is a real failure and is shown as itself rather than being
 * relabelled as a permissions problem.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = error instanceof Error ? error.message : String(error);
  const refused = message.includes("Not authorized");

  return (
    <PageShell
      title={refused ? "Not your dashboard" : "Something went wrong"}
      subtitle={
        refused
          ? "Deployment spend is visible to the account that owns the deployment."
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

const WINDOWS = [7, 30] as const;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (part: number, whole: number) =>
  whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`;

export default function AdminPage() {
  const [days, setDays] = useState<number>(30);
  const data = useQuery(api.admin.usage, { days });
  // A separate query rather than a field on `usage`: convex/admin.ts is fenced
  // to apiLogs and apiUsageTotals only, and widening that fence to reach the
  // budget ledger would cost more than joining two results here.
  const budgets = useQuery(api.budget.allBudgets);
  const limitFor = (account: string) =>
    budgets?.find((b) => b.userId === account);

  return (
    <PageShell
      title="Usage"
      subtitle="What this deployment is spending."
      back={{ to: "/settings", label: "Back to settings" }}
      actions={
        <div className="flex items-center gap-1">
          <Link
            to="/admin/issues"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Failures
          </Link>
          {WINDOWS.map((w) => (
            <Button
              key={w}
              size="sm"
              variant={w === days ? "secondary" : "ghost"}
              aria-pressed={w === days}
              onClick={() => setDays(w)}
            >
              {w} days
            </Button>
          ))}
        </div>
      }
    >
      {data === undefined ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <section>
            <SectionHeading>Lifetime</SectionHeading>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard
                label="API calls"
                value={data.lifetime.calls.toLocaleString()}
              />
              <StatCard
                label="Input tokens"
                value={formatTokens(data.lifetime.promptTokens)}
              />
              <StatCard
                label="Output tokens"
                value={formatTokens(data.lifetime.completionTokens)}
              />
              <StatCard
                label="Estimated cost"
                value={usd(data.lifetime.costUsd)}
              />
              <StatCard
                label="Cache hit rate"
                value={pct(
                  data.lifetime.cacheHits,
                  data.lifetime.cacheMeasuredCalls
                )}
                hint={`${data.lifetime.cacheMeasuredCalls.toLocaleString()} measured`}
              />
            </div>
          </section>

          <section>
            <SectionHeading>Last {days} days</SectionHeading>
            {data.window.truncated && (
              <Alert className="mb-3">
                Showing the most recent 5,000 calls. Totals below are a floor,
                not the full window.
              </Alert>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard
                label="API calls"
                value={data.window.calls.toLocaleString()}
              />
              <StatCard label="Cost" value={usd(data.window.costUsd)} />
              <StatCard
                label="Errors"
                value={data.window.errors.toLocaleString()}
                hint={pct(data.window.errors, data.window.calls)}
              />
              <StatCard
                label="Documents touched"
                value={data.window.documentsTouched.toLocaleString()}
              />
              <StatCard
                label="Input tokens"
                value={formatTokens(data.window.promptTokens)}
              />
              <StatCard
                label="Output tokens"
                value={formatTokens(data.window.completionTokens)}
              />
            </div>
          </section>

          <section>
            <SectionHeading>By operation</SectionHeading>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Operation</th>
                    <th className="py-2 pr-4 font-medium text-right">Calls</th>
                    <th className="py-2 pr-4 font-medium text-right">Cost</th>
                    <th className="py-2 pr-4 font-medium text-right">Errors</th>
                    <th className="py-2 pr-4 font-medium text-right">Cut off</th>
                    <th className="py-2 pr-4 font-medium text-right">p50</th>
                    <th className="py-2 font-medium text-right">p95</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byOperation.map((op) => (
                    <tr key={op.operation} className="border-b border-border/50">
                      <td className="py-2 pr-4">{op.operation}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {op.calls.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {usd(op.costUsd)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {op.errors > 0 ? (
                          <span className="text-destructive">{op.errors}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {op.truncatedOutputs > 0 ? (
                          <span className="text-warning">
                            {op.truncatedOutputs}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                        {(op.p50DurationMs / 1000).toFixed(1)}s
                      </td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">
                        {(op.p95DurationMs / 1000).toFixed(1)}s
                      </td>
                    </tr>
                  ))}
                  {data.byOperation.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="py-4 text-center text-muted-foreground"
                      >
                        No calls in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <SectionHeading>By account</SectionHeading>
            {/* "Unattributed" is a real row, not a rounding error: it collects
                calls whose document has since been deleted, and calls made
                before accounts existed. Worth keeping visible — if resolution
                in apiLogs.record ever breaks, this row is where it shows up. */}
            <p className="text-xs text-muted-foreground mb-3">
              Unattributed covers deleted documents and calls predating
              accounts.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Account</th>
                    <th className="py-2 pr-4 font-medium text-right">Calls</th>
                    <th className="py-2 pr-4 font-medium text-right">Cost</th>
                    <th className="py-2 pr-4 font-medium text-right">
                      Documents
                    </th>
                    <th className="py-2 pr-4 font-medium text-right">Input</th>
                    <th className="py-2 pr-4 font-medium text-right">Output</th>
                    <th className="py-2 pr-4 font-medium text-right">Errors</th>
                    <th className="py-2 font-medium text-right">Limit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAccount.map((a) => (
                    <tr key={a.account} className="border-b border-border/50">
                      <td className="py-2 pr-4">
                        {a.name || a.email ? (
                          <>
                            <div>{a.name ?? a.email}</div>
                            {a.name && a.email && (
                              <div className="text-xs text-muted-foreground">
                                {a.email}
                              </div>
                            )}
                          </>
                        ) : (
                          // Unattributed, or an account deleted since it spent.
                          <span className="text-muted-foreground">
                            {a.account === "Unattributed"
                              ? "Unattributed"
                              : "Deleted account"}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {a.calls.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {usd(a.costUsd)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {a.documentsTouched.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                        {formatTokens(a.promptTokens)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                        {formatTokens(a.completionTokens)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {a.errors > 0 ? (
                          <span className="text-destructive">{a.errors}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {limitFor(a.account) ? (
                          <AccountLimitCell
                            userId={a.account}
                            limitUsd={limitFor(a.account)!.limitUsd}
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.byAccount.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="py-4 text-center text-muted-foreground"
                      >
                        No calls in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <SectionHeading>By day</SectionHeading>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Day</th>
                    <th className="py-2 pr-4 font-medium text-right">Calls</th>
                    <th className="py-2 font-medium text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byDay.map((d) => (
                    <tr key={d.day} className="border-b border-border/50">
                      <td className="py-2 pr-4 tabular-nums">{d.day}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {d.calls.toLocaleString()}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {usd(d.costUsd)}
                      </td>
                    </tr>
                  ))}
                  {data.byDay.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
                        className="py-4 text-center text-muted-foreground"
                      >
                        No calls in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </PageShell>
  );
}

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import { CircleAlert, CircleCheck, Languages } from "lucide-react";
import { api } from "../../convex/_generated/api";
import ProviderAlert from "@/components/settings/ProviderAlert";
import { StatCard } from "@/components/settings/StatCard";
import { ProcessingQueueControls } from "@/components/settings/ProcessingQueueControls";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { INTERFAZE_LANGUAGES, languageName } from "@/lib/languages";
import { PageShell, SectionHeading } from "@/components/ui/page-shell";
import { useConfirm } from "@/components/ui/use-confirm";
import {
  formatApiDuration,
  formatCost,
  formatTokens,
  operationLabel,
} from "@/lib/usageFormat";

function formatTime(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return sameDay
    ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

const healthPill: Record<string, { label: string; cls: string }> = {
  ok: { label: "Healthy", cls: "bg-emerald-500/10 text-success" },
  quota_exhausted: { label: "Out of credits", cls: "bg-destructive/15 text-destructive" },
  auth_failed: { label: "Key rejected", cls: "bg-destructive/15 text-destructive" },
  not_configured: { label: "Not configured", cls: "bg-amber-500/15 text-warning" },
  error: { label: "Failing", cls: "bg-destructive/15 text-destructive" },
};

function HealthPill({ status }: { status?: string }) {
  if (!status) return null;
  const pill = healthPill[status];
  if (!pill) return null;
  return (
    <span className={`text-2xs rounded-full px-2 py-0.5 font-medium ${pill.cls}`}>
      {pill.label}
    </span>
  );
}

export default function SettingsPage() {
  const totals = useQuery(api.apiLogs.totals);
  const isAdmin = useQuery(api.authz.isAdmin);
  const logs = useQuery(api.apiLogs.list);
  const health = useQuery(api.providerHealth.list);
  const settings = useQuery(api.settings.get);
  const updateDefaultLanguage = useMutation(api.settings.updateDefaultLanguage);
  const geminiStatus = health?.find((h) => h.provider === "google")?.status;
  const [languageDraft, setLanguageDraft] = useState("en");
  const [savingLanguage, setSavingLanguage] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    if (settings?.defaultLanguageCode) {
      setLanguageDraft(settings.defaultLanguageCode);
    }
  }, [settings?.defaultLanguageCode]);

  async function saveLanguage() {
    if (savingLanguage || languageDraft === settings?.defaultLanguageCode) return;

    const confirmed = await confirm({
      title: `Change the default language to ${languageName(languageDraft)}?`,
      body: "This retranslates the existing archive in the background and will incur additional API cost. Original source text is preserved.",
      confirmLabel: "Change language",
    });
    if (!confirmed) return;

    setSavingLanguage(true);
    try {
      await updateDefaultLanguage({ languageCode: languageDraft });
    } finally {
      setSavingLanguage(false);
    }
  }

  return (
    <PageShell
      title="Settings & Usage"
      subtitle="API activity, token usage, and estimated cost. Categories and entity types are per project — see that project's settings."
      back={{ to: "/", label: "Back to projects" }}
    >
      <>
          {/* Provider health — loud when a provider is down or out of credits */}
          <ProviderAlert />

          {/* Operator-only: pausing and cancelling act on the one deployment-wide queue
              every account's documents run through, so these are not the
              reader's controls to hold. The server refuses them either way. */}
          {isAdmin && (
            <>
              <SectionHeading>Processing</SectionHeading>
              <ProcessingQueueControls />
            </>
          )}

          <SectionHeading>Language</SectionHeading>
          <div className="rounded-lg border bg-card p-4 mb-8">
            <div className="flex items-start gap-3">
              <Languages className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <label htmlFor="default-language" className="text-sm font-medium">
                  Default language
                </label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  New documents in another language are translated
                  automatically. Existing documents update in the background
                  when this changes.
                </p>
                {settings === undefined ? (
                  <Skeleton className="mt-3 h-9 w-full max-w-sm" />
                ) : (
                  <div className="mt-3 flex max-w-md items-center gap-2">
                    <select
                      id="default-language"
                      value={languageDraft}
                      onChange={(event) => setLanguageDraft(event.target.value)}
                      className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/30"
                    >
                      {INTERFAZE_LANGUAGES.map((language) => (
                        <option key={language.code} value={language.code}>
                          {language.name} ({language.code})
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      disabled={
                        savingLanguage ||
                        languageDraft === settings.defaultLanguageCode
                      }
                      onClick={() => void saveLanguage()}
                    >
                      {savingLanguage ? "Saving…" : "Save"}
                    </Button>
                  </div>
                )}
                {settings && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Current default: {languageName(settings.defaultLanguageCode)}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Usage summary */}
          <SectionHeading>Usage</SectionHeading>
          {/* Tidiness only — the server is the gate. A non-admin who types
              /admin gets a thrown error either way. */}
          {isAdmin && (
            <p className="-mt-4 mb-4 text-sm text-muted-foreground">
              <Link to="/admin" className="font-medium text-foreground underline">
                Usage across the deployment
              </Link>{" "}
              — spend by operation and by day.
            </p>
          )}
          {totals === undefined ? (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
              <StatCard label="API calls" value={totals.calls.toLocaleString()} />
              <StatCard label="Input tokens" value={formatTokens(totals.promptTokens)} />
              <StatCard label="Output tokens" value={formatTokens(totals.completionTokens)} />
              <StatCard
                label="Est. cost"
                value={formatCost(totals.costUsd)}
                hint="All time, based on list prices"
              />
              <StatCard
                label="vcache hits"
                value={
                  totals.cacheMeasuredCalls > 0
                    ? totals.cacheHits.toLocaleString()
                    : "—"
                }
                hint={
                  totals.cacheMeasuredCalls > 0
                    ? `${Math.round(
                        (totals.cacheHits / totals.cacheMeasuredCalls) * 100
                      )}% of ${totals.cacheMeasuredCalls.toLocaleString()} tracked Interfaze calls`
                    : "No tracked Interfaze calls yet"
                }
              />
            </div>
          )}

          {/* API log */}
          <SectionHeading>API log</SectionHeading>
          {logs === undefined ? (
            <div className="space-y-2 mb-8">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center border rounded-lg mb-8">
              No API calls logged yet. Upload a document to see activity here.
            </p>
          ) : (
            <div className="border rounded-lg overflow-x-auto mb-8">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Operation</th>
                    <th className="px-3 py-2 font-medium">Document</th>
                    <th className="px-3 py-2 font-medium text-right">Tokens in</th>
                    <th className="px-3 py-2 font-medium text-right">Tokens out</th>
                    <th className="px-3 py-2 font-medium text-right">Duration</th>
                    <th className="px-3 py-2 font-medium text-right">Cost</th>
                    <th className="px-3 py-2 font-medium text-center">vcache</th>
                    <th className="px-3 py-2 font-medium text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log._id} className="border-b last:border-b-0 hover:bg-accent/30">
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                        {formatTime(log._creationTime)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {operationLabel(log.operation)}
                        <span className="text-xs text-muted-foreground ml-1.5">
                          {log.model}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-40">
                        {log.documentId && log.documentName ? (
                          <Link
                            to={`/documents/${log.documentId}`}
                            className="hover:underline block truncate"
                            title={log.documentName}
                          >
                            {log.documentName}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatTokens(log.promptTokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatTokens(log.completionTokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatApiDuration(log.durationMs)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCost(log.costUsd)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {log.cacheHit === undefined ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={
                              log.cacheHit
                                ? "text-success"
                                : "text-muted-foreground"
                            }
                          >
                            {log.cacheHit ? "Hit" : "Miss"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {log.status === "ok" ? (
                          <CircleCheck className="size-4 text-success inline" />
                        ) : (
                          <CircleAlert
                            className="size-4 text-destructive inline"
                            aria-label={log.error}
                          />
                        )}
                        {log.status === "error" && log.error && (
                          <span className="sr-only">{log.error}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Provider settings */}
          <SectionHeading>AI providers</SectionHeading>
          <div className="border rounded-lg divide-y">
            <div className="p-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Interfaze</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Document parsing, extraction, transcription, research, and
                  search — model <code>interfaze-beta</code>, zero data
                  retention enabled.
                </p>
              </div>
              <p className="text-xs text-muted-foreground whitespace-nowrap">
                $1.50 / $3.50 per M tokens
              </p>
            </div>
            <div className="p-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  Google Gemini
                  <HealthPill status={geminiStatus} />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Page embeddings for semantic search —{" "}
                  <code>gemini-embedding-2</code>.
                </p>
              </div>
              <p className="text-xs text-muted-foreground whitespace-nowrap">
                $0.20 per M tokens
              </p>
            </div>
            <div className="p-4">
              <p className="text-xs text-muted-foreground">
                API keys are stored as Convex deployment environment variables
                (<code>INTERFAZE_API_KEY</code>, <code>GEMINI_API_KEY</code>).
                Costs shown are estimates computed from reported token counts
                and list prices; check your provider dashboards for billing.
              </p>
            </div>
          </div>
      </>
    </PageShell>
  );
}

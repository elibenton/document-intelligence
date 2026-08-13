import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { ArrowLeft, CircleAlert, CircleCheck, Languages, RefreshCw } from "lucide-react";
import { api } from "../../convex/_generated/api";
import ProviderAlert from "@/components/settings/ProviderAlert";
import { ProcessingQueueControls } from "@/components/settings/ProcessingQueueControls";
import { DocumentCategoriesSettings } from "@/components/settings/DocumentCategoriesSettings";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { INTERFAZE_LANGUAGES, languageName } from "@/lib/languages";

const operationLabels: Record<string, string> = {
  parse: "Parse",
  translate: "Translate",
  extract: "Extract",
  transcribe: "Transcribe",
  visual: "Visual scan",
  metadata: "Metadata",
  relationships: "Relationships",
  research: "Research",
  search_plan: "Search · plan",
  search_answer: "Search · answer",
  embeddings: "Embeddings",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

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

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold mt-1">{value}</p>
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

const healthPill: Record<string, { label: string; cls: string }> = {
  ok: { label: "Healthy", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  quota_exhausted: { label: "Out of credits", cls: "bg-destructive/15 text-destructive" },
  auth_failed: { label: "Key rejected", cls: "bg-destructive/15 text-destructive" },
  not_configured: { label: "Not configured", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  error: { label: "Failing", cls: "bg-destructive/15 text-destructive" },
};

function HealthPill({ status }: { status?: string }) {
  if (!status) return null;
  const pill = healthPill[status];
  if (!pill) return null;
  return (
    <span className={`text-[10px] rounded-full px-2 py-0.5 font-medium ${pill.cls}`}>
      {pill.label}
    </span>
  );
}

export default function SettingsPage() {
  const totals = useQuery(api.apiLogs.totals);
  const logs = useQuery(api.apiLogs.list);
  const health = useQuery(api.providerHealth.list);
  const settings = useQuery(api.settings.get);
  const geometryBackfill = useQuery(api.pageImages.geometryBackfillStatus);
  const updateDefaultLanguage = useMutation(api.settings.updateDefaultLanguage);
  const startGeometryBackfill = useMutation(api.pageImages.startGeometryBackfill);
  const geminiStatus = health?.find((h) => h.provider === "google")?.status;
  const [languageDraft, setLanguageDraft] = useState("en");
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [startingBackfill, setStartingBackfill] = useState(false);

  useEffect(() => {
    if (settings?.defaultLanguageCode) {
      setLanguageDraft(settings.defaultLanguageCode);
    }
  }, [settings?.defaultLanguageCode]);

  async function saveLanguage() {
    if (savingLanguage || languageDraft === settings?.defaultLanguageCode) return;

    const confirmed = window.confirm(
      `Change the default language to ${languageName(languageDraft)}?\n\n` +
        "This will retranslate the existing archive in the background and may incur additional API costs. Original source text will be preserved."
    );
    if (!confirmed) return;

    setSavingLanguage(true);
    try {
      await updateDefaultLanguage({ languageCode: languageDraft });
    } finally {
      setSavingLanguage(false);
    }
  }

  async function runGeometryBackfill() {
    if (startingBackfill || geometryBackfill?.status === "running") return;
    setStartingBackfill(true);
    try {
      await startGeometryBackfill({});
    } finally {
      setStartingBackfill(false);
    }
  }

  return (
    <div className="flex flex-col">
      <header className="border-b px-6 py-4 flex items-center gap-3">
        <Link
          to="/"
          className="p-1.5 -ml-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          title="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-xl font-bold">Settings & Usage</h1>
          <p className="text-sm text-muted-foreground">
            API activity, token usage, and estimated cost.
          </p>
        </div>
      </header>

      <div className="flex-1">
        <div className="p-6 max-w-4xl">
          {/* Provider health — loud when a provider is down or out of credits */}
          <ProviderAlert />

          <h2 className="text-lg font-semibold mb-3">Document categories</h2>
          <p className="text-sm text-muted-foreground mb-3">
            The enforced primary categories Analyze sorts every document into.
            Add your own, or adjust how the built-in ones are described.
          </p>
          <DocumentCategoriesSettings />

          <h2 className="text-lg font-semibold mb-3">Processing</h2>
          <ProcessingQueueControls />

          <div className="mb-8 rounded-lg border bg-card p-4">
            <div className="flex items-start gap-3">
              <RefreshCw
                className={`mt-0.5 h-5 w-5 shrink-0 text-muted-foreground ${geometryBackfill?.status === "running" ? "animate-spin" : ""}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">PDF highlight geometry</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Rebuild existing PDFs with current word boxes and hidden-text detection.
                  The job is resumable and skips documents that are already current.
                </p>
                {geometryBackfill && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {geometryBackfill.status === "running" ? "Running" : "Last run complete"}
                    {` · ${geometryBackfill.scanned.toLocaleString()} scanned · ${geometryBackfill.scheduled.toLocaleString()} queued · renderer v${geometryBackfill.rendererVersion}`}
                  </p>
                )}
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={startingBackfill || geometryBackfill?.status === "running"}
                  onClick={() => void runGeometryBackfill()}
                >
                  {geometryBackfill?.status === "running"
                    ? "Backfill running…"
                    : startingBackfill
                      ? "Starting…"
                      : "Backfill existing PDFs"}
                </Button>
              </div>
            </div>
          </div>

          <h2 className="text-lg font-semibold mb-3">Language</h2>
          <div className="rounded-lg border bg-card p-4 mb-8">
            <div className="flex items-start gap-3">
              <Languages className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
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
          <h2 className="text-lg font-semibold mb-3">Usage</h2>
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
          <h2 className="text-lg font-semibold mb-3">API log</h2>
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
                        {operationLabels[log.operation] ?? log.operation}
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
                        {formatDuration(log.durationMs)}
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
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-muted-foreground"
                            }
                          >
                            {log.cacheHit ? "Hit" : "Miss"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {log.status === "ok" ? (
                          <CircleCheck className="h-4 w-4 text-emerald-500 inline" />
                        ) : (
                          <CircleAlert
                            className="h-4 w-4 text-destructive inline"
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
          <h2 className="text-lg font-semibold mb-3">AI providers</h2>
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
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { CircleCheck, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { api } from "../../../convex/_generated/api";

/**
 * Loud alarm for a dead AI provider.
 *
 * Gemini running out of credits does not throw anywhere the user can see —
 * semantic search just stops contributing and every answer quietly gets
 * worse. This banner is the only thing standing between that and a silent
 * quality regression, so it is deliberately impossible to miss.
 */

type Health = {
  provider: string;
  status: string;
  message?: string;
  lastOkAt?: number;
  lastErrorAt?: number;
  consecutiveFailures: number;
  updatedAt: number;
};

const providerLabels: Record<string, string> = {
  google: "Google Gemini",
  interfaze: "Interfaze",
};

/** Headline + what it actually costs the user + how to fix it. */
const statusCopy: Record<
  string,
  { headline: (p: string) => string; fix: string }
> = {
  quota_exhausted: {
    headline: (p) => `${p} is out of credits`,
    fix: "Add credits or raise the quota in Google AI Studio, then run Check now.",
  },
  auth_failed: {
    headline: (p) => `${p} rejected your API key`,
    fix: "Set a valid key with `npx convex env set GEMINI_API_KEY …`, then run Check now.",
  },
  not_configured: {
    headline: (p) => `${p} is not configured`,
    fix: "Set the key with `npx convex env set GEMINI_API_KEY …`, then run Check now.",
  },
  error: {
    headline: (p) => `${p} is failing`,
    fix: "Check the message below and Google's status page, then run Check now.",
  },
};

const IMPACT =
  "Semantic search is switched off. Deep search still returns keyword and entity-graph results, so it keeps working — but pages that match by meaning rather than exact wording are being missed, and answers will be less complete.";

function formatWhen(ts?: number): string {
  if (!ts) return "never";
  const date = new Date(ts);
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ProviderAlert() {
  const health = useQuery(api.providerHealth.list);
  const check = useAction(api.embeddings.checkHealth);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  async function runCheck() {
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await check({});
      setCheckResult(
        result.status === "ok"
          ? "Gemini responded normally — semantic search is live again."
          : (result.message ?? `Still failing (${result.status}).`)
      );
    } catch (e) {
      setCheckResult(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  if (health === undefined) return null;

  const broken = (health as Health[]).filter((h) => h.status !== "ok");
  if (broken.length === 0) {
    // Healthy: no alarm, but keep the manual probe reachable.
    return (
      <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
        <CircleCheck className="h-4 w-4 text-emerald-500 shrink-0" />
        <span>All AI providers responding.</span>
        <button
          onClick={() => void runCheck()}
          disabled={checking}
          className="ml-1 text-xs border rounded px-2 py-0.5 hover:bg-accent transition-colors disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check now"}
        </button>
        {checkResult && <span className="text-xs">{checkResult}</span>}
      </div>
    );
  }

  return (
    <div className="mb-6 space-y-3">
      {broken.map((h) => {
        const label = providerLabels[h.provider] ?? h.provider;
        const copy = statusCopy[h.status] ?? statusCopy.error;
        return (
          <div
            key={h.provider}
            role="alert"
            className="rounded-lg border-2 border-destructive bg-destructive/10 p-4"
          >
            <div className="flex items-start gap-3">
              <TriangleAlert className="h-6 w-6 text-destructive shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-destructive">
                  {copy.headline(label)}
                </h3>
                <p className="text-sm mt-1.5">{IMPACT}</p>
                <p className="text-sm mt-2 font-medium">{copy.fix}</p>

                {h.message && (
                  <p className="text-xs text-muted-foreground mt-2 font-mono break-words border-l-2 border-destructive/40 pl-2">
                    {h.message}
                  </p>
                )}

                <p className="text-xs text-muted-foreground mt-2">
                  Last succeeded {formatWhen(h.lastOkAt)} · failing since{" "}
                  {formatWhen(h.lastErrorAt)} · {h.consecutiveFailures}{" "}
                  consecutive {h.consecutiveFailures === 1 ? "failure" : "failures"}
                </p>

                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <button
                    onClick={() => void runCheck()}
                    disabled={checking}
                    className="inline-flex items-center gap-1.5 text-sm bg-destructive text-destructive-foreground rounded-md px-3 py-1.5 hover:bg-destructive/90 transition-colors disabled:opacity-60"
                  >
                    {checking && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {checking ? "Checking…" : "Check now"}
                  </button>
                  {h.provider === "google" && (
                    <a
                      href="https://aistudio.google.com/apikey"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm border rounded-md px-3 py-1.5 hover:bg-accent transition-colors"
                    >
                      Google AI Studio
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {checkResult && (
                    <span className="text-xs text-muted-foreground">
                      {checkResult}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

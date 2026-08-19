import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, RotateCw, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/spinner";
import { isAudioVideo, parseStageLabel } from "./docStatus";
import { cn } from "@/lib/utils";
import { isCsvDocument } from "@/lib/uploadTypes";
import { languageName } from "@/lib/languages";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { FLOATING_SURFACE } from "@/components/viewer/surfaces";
import { AnalyzeRetryDialog } from "./StageRetryDialog";
import {
  formatApiDuration,
  formatCost,
  formatTokens,
} from "@/lib/usageFormat";

type StepStatus = "pending" | "running" | "completed" | "failed";

/**
 * A step's retry affordance, revealed on hover/focus in place of its marker.
 *
 * Absent means there is deliberately nothing to reveal — that is how Scan says
 * "a successful scan is not re-runnable" rather than showing a disabled button
 * the user has to reason about.
 */
interface StepRetry {
  label: string;
  onActivate: () => void;
}

interface Step {
  key: string;
  label: string;
  retry?: StepRetry;
  detail?: string;
  /** Secondary line under a step — a derived side-effect, not a stage. */
  note?: string;
  noteStatus?: StepStatus;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
}

/** Ticks once per second while `active`, for live elapsed-time labels. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Live pipeline for a document, as a vertical list: Scan → Analyze.
 *
 * Scan is the one understanding call (text, geometry, metadata, and the
 * entity graph in a single request); Analyze is the text-in re-run that owns
 * the editable-prompt retry. A queued step renders as running.
 *
 * Upload is not a step. By the time this renders the upload has succeeded, so a
 * permanently-checked box only added width. Translation is not a step either:
 * it is a derived layer over the scan, so it reads as a note under Scan rather
 * than a peer of it.
 */
export function PipelineProgress({
  document,
  compact = false,
  floating = false,
  collapseWhenDone = false,
}: {
  document: Doc<"documents">;
  compact?: boolean;
  /**
   * Render as a shadowed floating card (rounded-xl, shadow-md) instead of the
   * plain bordered box this uses inline in a tab. See surfaces.ts.
   */
  floating?: boolean;
  /**
   * Once there is nothing left needing attention, collapse to a single
   * "Processing complete" row instead of the full step list. Used where this
   * lives as its own panel rather than inline in a tab someone already
   * opened to check on it.
   */
  collapseWhenDone?: boolean;
}) {
  const documentId = document._id as Id<"documents">;
  const retryPipeline = useMutation(api.processing.runFullPipeline);
  const retryAnalyze = useMutation(api.processing.runAnalyze);
  const [retrying, setRetrying] = useState(false);
  const [dialog, setDialog] = useState<"analyze" | null>(null);
  const analyzePrompt = useQuery(
    api.analyzePrompt.forDocument,
    dialog === "analyze" ? { documentId } : "skip"
  );
  const jobs = useQuery(api.processingJobs.byDocument, { documentId });
  // Only the collapsed "Processing complete" row shows the usage summary, so
  // the query is skipped everywhere else.
  const usage = useQuery(
    api.apiLogs.byDocument,
    collapseWhenDone ? { documentId } : "skip"
  );
  const control = useQuery(api.processingControl.get);
  const pages = useQuery(
    api.pages.byDocument,
    document.status === "parsing" || document.status === "uploaded"
      ? "skip"
      : { documentId }
  );

  const jobByStage = new Map((jobs ?? []).map((j) => [j.stage, j]));
  // "transcribe" rows are from before recordings joined the one-call pipeline.
  const parseJob = jobByStage.get("parse") ?? jobByStage.get("transcribe");
  const analyzeJob = jobByStage.get("analyze");

  const failed = document.status === "failed";

  const jobStatus = (
    job: typeof parseJob,
    fallback: StepStatus = "pending"
  ): StepStatus => {
    if (!job) return fallback;
    if (job.status === "running") return "running";
    if (job.status === "completed") return "completed";
    if (job.status === "failed") return "failed";
    return "pending";
  };

  const parseStatus = jobStatus(
    parseJob,
    document.status === "uploaded" ? "pending" : "completed"
  );
  const parseDone =
    parseStatus === "completed" ||
    ["parsed", "extracting", "completed"].includes(document.status);

  const recording = isAudioVideo(document);
  const csv = isCsvDocument(document);
  const pageTotal = document.pageCount ?? pages?.length;

  // Every medium takes the one understanding call now, recordings included, so
  // metadata presence is the truth for all of them.
  const analyzeDone = Boolean(document.metadata || document.primaryKind);

  const scanStatus: StepStatus =
    parseJob?.status === "canceled" || (failed && parseStatus === "running")
      ? "failed"
      : parseStatus;

  async function runScanRetry() {
    if (retrying) return;
    setRetrying(true);
    try {
      await retryPipeline({ documentId });
    } finally {
      setRetrying(false);
    }
  }

  const translationNote = (): string | undefined => {
    switch (document.translationStatus) {
      case "not_needed":
        return `Already ${languageName(document.sourceLanguageCode)}`;
      case "translating":
        return `Translating to ${languageName(document.translationLanguageCode)}…`;
      case "complete":
        return `Translated to ${languageName(document.translationLanguageCode)}`;
      case "failed":
        return "Translation failed";
      default:
        return undefined;
    }
  };

  const steps: Step[] = [
    {
      key: "scan",
      label: recording ? parseStageLabel(document) : "Scan",
      detail:
        parseStatus === "running"
          ? csv
            ? "Reading rows and columns"
            : recording
              ? "Transcribing with speaker labels"
              : "Reading text, geometry, and objects"
          : parseDone && pageTotal
            ? csv
              ? "Parsed"
              : `${pageTotal} page${pageTotal === 1 ? "" : "s"}, searchable`
            : undefined,
      note: translationNote(),
      noteStatus:
        document.translationStatus === "failed"
          ? "failed"
          : document.translationStatus === "translating"
            ? "running"
            : "completed",
      status: scanStatus,
      // No re-scan of a good scan: extractions, entities and page geometry are
      // all built on it, so silently replacing it would invalidate them.
      retry:
        scanStatus === "failed"
          ? { label: "Retry scan", onActivate: () => void runScanRetry() }
          : undefined,
      startedAt: parseJob?.startedAt,
      completedAt: parseJob?.completedAt,
    },
    {
      key: "analyze",
      label: "Analyze",
      retry: parseDone
        ? { label: "Re-run analyze…", onActivate: () => setDialog("analyze") }
        : undefined,
      startedAt: analyzeJob?.startedAt,
      completedAt: analyzeJob?.completedAt,
      // Entities and relationships ride on the same understanding call, so
      // this step is the whole enrichment — there is no third stage.
      detail: analyzeDone
        ? [document.primaryKind, document.displayName ? "titled" : undefined]
            .filter(Boolean)
            .join(" · ") || "Understood"
        : parseDone
          ? "Identifying type, structure, and connections"
          : undefined,
      // A standalone Analyze re-run owns the step while it is in flight, so its
      // job wins over the metadata-derived guess.
      status:
        analyzeJob?.status === "running" || analyzeJob?.status === "pending"
          ? "running"
          : analyzeJob?.status === "failed"
            ? "failed"
            : failed
              ? parseStatus === "failed"
                ? "pending"
                : "failed"
              : analyzeDone
                ? "completed"
                : parseDone
                  ? "running"
                  : "pending",
    },
  ];

  const anyRunning = steps.some((s) => s.status === "running");
  const anyPending = (jobs ?? []).some(
    (j) => j.status === "pending" && j.workId
  );
  const anyActive = anyRunning || anyPending;
  const now = useNow(anyActive);

  const allDone = document.status === "completed" && !anyRunning;
  const errorMessage =
    document.errorMessage ?? document.translationError ??
    (jobs ?? []).find((j) => j.errorMessage)?.errorMessage;

  // Nothing to show for finished docs in compact mode
  if (compact && allDone) return null;
  if (!jobs) return null;

  // Something still needs the user's eyes even though the pipeline itself
  // finished — a failed translation, a canceled run with a retry waiting.
  // Those cases stay expanded; only a clean finish collapses.
  const nothingToFlag =
    allDone &&
    document.translationStatus !== "failed" &&
    document.errorCode !== "processing_canceled";

  if (collapseWhenDone && nothingToFlag) {
    // The one line the user sees on every finished document, so this is where
    // "what did this cost" lives: total API time, tokens, and dollars, with
    // the per-operation breakdown one click away in the Info tab.
    const total = (usage ?? []).reduce(
      (sum, r) => ({
        durationMs: sum.durationMs + r.durationMs,
        tokens: sum.tokens + r.promptTokens + r.completionTokens,
        costUsd: sum.costUsd + r.costUsd,
      }),
      { durationMs: 0, tokens: 0, costUsd: 0 }
    );
    return (
      <div
        className={cn(
          "flex items-center gap-2",
          floating ? cn(FLOATING_SURFACE, "px-3 py-2.5") : "rounded-lg border bg-card px-3 py-2.5"
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" strokeWidth={3} />
        </span>
        <span className="text-sm text-foreground">Processing complete</span>
        {usage && usage.length > 0 && (
          <Tooltip content="Total API time, tokens, and estimated cost for this document — see the Info tab for the per-operation breakdown.">
            <span className="ml-auto text-2xs tabular-nums text-muted-foreground">
              {formatApiDuration(total.durationMs)} ·{" "}
              {formatTokens(total.tokens)} tok · {formatCost(total.costUsd)}
            </span>
          </Tooltip>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        !compact && (floating ? cn(FLOATING_SURFACE, "p-3") : "rounded-lg border bg-card p-3")
      )}
    >
      {/* One status line, not four. The running step already carries a
          spinner, so the header adds only the words a spinner cannot say. */}
      {!compact && (
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">
            {failed
              ? "Processing failed"
              : allDone
                ? "Processing complete"
                : anyPending && !anyRunning
                  ? "Queued"
                  : "Processing"}
          </h3>
          {control?.paused && anyActive && (
            <span className="text-xs text-foreground shrink-0">
              Paused in processing settings
            </span>
          )}
        </div>
      )}

      <ol className="flex flex-col">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          const duration =
            step.status === "running" && step.startedAt
              ? formatDuration(now - step.startedAt)
              : step.status === "completed" && step.startedAt && step.completedAt
                ? formatDuration(step.completedAt - step.startedAt)
                : null;

          return (
            <li key={step.key} className="group/step flex items-stretch gap-2.5">
              {/* Rail: marker plus the connector down to the next step. The
                  marker doubles as the retry control where one exists — same
                  20px circle, swapped contents, so nothing reflows on hover. */}
              <div className="flex flex-col items-center">
                <StepMarker status={step.status} retry={step.retry} />
                {!isLast && (
                  <div
                    className={cn(
                      "w-px flex-1 my-1 rounded",
                      step.status === "completed" ? "bg-primary/40" : "bg-border"
                    )}
                  />
                )}
              </div>

              <div className={cn("min-w-0 flex-1", !isLast && "pb-3")}>
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "text-sm leading-5",
                      step.status === "running"
                        ? "font-medium text-foreground"
                        : step.status === "completed"
                          ? "text-foreground"
                          : step.status === "failed"
                            ? "text-destructive"
                            : "text-foreground"
                    )}
                  >
                    {step.label}
                  </span>
                  {duration && (
                    <span className="text-2xs tabular-nums text-foreground shrink-0">
                      {duration}
                    </span>
                  )}
                </div>

                {step.detail && (
                  <p className="text-xs text-foreground leading-snug truncate">
                    {step.detail}
                  </p>
                )}

                {step.note && (
                  <p
                    className={cn(
                      "text-xs leading-snug truncate",
                      step.noteStatus === "failed"
                        ? "text-destructive"
                        : "text-foreground"
                    )}
                  >
                    {step.note}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {(failed || document.translationStatus === "failed") && errorMessage && (
        <p className="text-xs text-destructive leading-snug">{errorMessage}</p>
      )}

      {document.errorCode === "processing_canceled" && (
        <Button
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await retryPipeline({ documentId });
            } finally {
              setRetrying(false);
            }
          }}
        >
          {retrying ? "Queueing…" : "Retry processing"}
        </Button>
      )}

      {dialog === "analyze" && analyzePrompt !== undefined && (
        <AnalyzeRetryDialog
          defaultPrompt={analyzePrompt ?? ""}
          onClose={() => setDialog(null)}
          onRun={async (prompt) => {
            await retryAnalyze({
              documentId,
              promptOverride: prompt,
              // An edited prompt is its own cache key. An unedited one would
              // just replay the cached answer, which is not what the user
              // pressing retry asked for — so force a fresh call.
              bypassCache: prompt.trim() === (analyzePrompt ?? "").trim(),
            });
          }}
        />
      )}

    </div>
  );
}

/**
 * The rail marker, and — where the stage is re-runnable — the retry button.
 *
 * Both live in the same fixed 20px box and are cross-faded, so revealing the
 * control on hover never moves the row. The button is always in the DOM and
 * focusable, so keyboard and screen-reader users reach it the same way; only
 * its opacity is conditional.
 */
function StepMarker({
  status,
  retry,
}: {
  status: StepStatus;
  retry?: StepRetry;
}) {
  const [focused, setFocused] = useState(false);
  if (!retry) return <StepIcon status={status} />;
  return (
    <span className="relative size-4 shrink-0">
      <span
        className={cn(
          "absolute inset-0 transition-opacity group-hover/step:opacity-0",
          focused && "opacity-0"
        )}
      >
        <StepIcon status={status} />
      </span>
      <button
        type="button"
        aria-label={retry.label}
        title={retry.label}
        onClick={retry.onActivate}
        onFocus={(e) => setFocused(e.currentTarget.matches(":focus-visible"))}
        onBlur={() => setFocused(false)}
        className={cn(
          "absolute inset-0 flex size-5 items-center justify-center rounded-full",
          "border-2 border-primary bg-background text-primary",
          "opacity-0 transition-opacity group-hover/step:opacity-100 focus-visible:opacity-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        )}
      >
        <RotateCw className="size-3" strokeWidth={3} />
      </button>
    </span>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "running") {
    return <Spinner className="size-4 text-primary" />;
  }
  if (status === "completed") {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-red-600 text-white">
        <X className="size-3" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span className="flex size-5 items-center justify-center rounded-full border-2 border-border bg-background" />
  );
}

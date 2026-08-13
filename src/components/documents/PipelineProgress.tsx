import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Check, RotateCw, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/spinner";
import { isAudioVideo, parseStageLabel } from "./DocStatusIndicator";
import { cn } from "@/lib/utils";
import { isCsvDocument } from "@/lib/uploadTypes";
import { languageName } from "@/lib/languages";
import { Button } from "@/components/ui/button";
import {
  AnalyzeRetryDialog,
  ExtractRetryDialog,
  type TemplateRole,
} from "./StageRetryDialog";

type StepStatus = "pending" | "running" | "completed" | "failed" | "waiting";

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

interface ProcessingEstimateValue {
  stage: string;
  status: "pending" | "running";
  queuedAt: number;
  startedAt?: number;
  estimatedDurationMs: number;
  estimatedWaitMs: number;
  queuePosition?: number;
  sampleSize: number;
  paused: boolean;
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

function formatRoundedDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return "less than a minute";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}

function estimateText(
  estimate: ProcessingEstimateValue,
  now: number
): string {
  if (estimate.paused && estimate.status === "pending") {
    return "Paused in processing settings";
  }
  if (estimate.status === "pending") {
    const ahead = Math.max(0, (estimate.queuePosition ?? 1) - 1);
    const waited = Math.max(0, now - estimate.queuedAt);
    const remainingWait = Math.max(0, estimate.estimatedWaitMs - waited);
    if (ahead === 0 && remainingWait < 30_000) return "Starting soon";
    const queue = ahead === 1 ? "1 job ahead" : `${ahead} jobs ahead`;
    return `${queue} · ${formatRoundedDuration(remainingWait)} to start`;
  }

  const elapsed = estimate.startedAt ? Math.max(0, now - estimate.startedAt) : 0;
  const remaining = estimate.estimatedDurationMs - elapsed;
  if (remaining <= 0) return "Taking longer than recent runs";
  return `${formatRoundedDuration(remaining)} remaining`;
}

export function ProcessingEstimate({
  documentId,
  className,
}: {
  documentId: Id<"documents">;
  className?: string;
}) {
  const estimate = useQuery(api.processingJobs.estimateByDocument, { documentId });
  const now = useNow(estimate?.status === "pending" || estimate?.status === "running");
  if (!estimate) return null;
  return (
    <span
      className={className}
      title={
        estimate.sampleSize > 0
          ? `Estimate uses the median of ${estimate.sampleSize} recent ${estimate.stage} run${estimate.sampleSize === 1 ? "" : "s"}.`
          : "Early estimate; this will improve as more jobs finish."
      }
    >
      {estimateText(estimate, now)}
    </span>
  );
}

/**
 * Live pipeline for a document, as a vertical list: Scan → Analyze → Extract.
 *
 * Those three are the product's vocabulary, so the UI names them even though
 * the backend still produces Scan and Analyze from a single Interfaze
 * completion — they will simply separate in time once the calls are split, with
 * no change here.
 *
 * Upload is not a step. By the time this renders the upload has succeeded, so a
 * permanently-checked box only added width. Translation is not a step either:
 * it is a derived layer over the scan, so it reads as a note under Scan rather
 * than a peer of it.
 */
export function PipelineProgress({
  document,
  compact = false,
}: {
  document: Doc<"documents">;
  compact?: boolean;
}) {
  const documentId = document._id as Id<"documents">;
  const retryPipeline = useAction(api.processing.runFullPipeline);
  const retryAnalyze = useAction(api.processing.runAnalyze);
  const retryExtract = useAction(api.processing.runTemplateExtraction);
  const [retrying, setRetrying] = useState(false);
  const [dialog, setDialog] = useState<"analyze" | "extract" | null>(null);
  const analyzePrompt = useQuery(
    api.analyzePrompt.forDocument,
    dialog === "analyze" ? { documentId } : "skip"
  );
  const kinds = useQuery(api.kinds.list, dialog === "extract" ? {} : "skip");
  const jobs = useQuery(api.processingJobs.byDocument, { documentId });
  const estimate = useQuery(api.processingJobs.estimateByDocument, { documentId });
  const pages = useQuery(
    api.pages.byDocument,
    document.status === "parsing" || document.status === "uploaded"
      ? "skip"
      : { documentId }
  );

  const jobByStage = new Map((jobs ?? []).map((j) => [j.stage, j]));
  const parseJob = jobByStage.get("parse") ?? jobByStage.get("transcribe");
  const extractJob = jobByStage.get("extract");
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

  // Extract waits on the human confirming the template after parse
  let extractStatus: StepStatus = jobStatus(extractJob, "pending");
  if (
    !extractJob ||
    extractJob.status === "pending" ||
    extractJob.status === "canceled"
  ) {
    if (document.status === "completed") extractStatus = "completed";
    else if (parseDone && !failed) extractStatus = "waiting";
  }

  const recording = isAudioVideo(document);
  const csv = isCsvDocument(document);
  const pageTotal = document.pageCount ?? pages?.length;

  // Recordings never run the metadata pass (convex/processingNode.ts hands the
  // transcript to the rename pass instead), so their analysis lands with the
  // transcript rather than after it.
  const analyzeDone = recording
    ? parseDone
    : Boolean(document.metadata || document.primaryKind);

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
      detail: analyzeDone
        ? [document.primaryKind, document.displayName ? "titled" : undefined]
            .filter(Boolean)
            .join(" · ") || "Understood"
        : parseDone
          ? "Identifying type and structure"
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
    {
      key: "extract",
      label: "Extract",
      retry: parseDone
        ? { label: "Re-run extract…", onActivate: () => setDialog("extract") }
        : undefined,
      detail:
        extractStatus === "waiting"
          ? "Confirm what to pull out"
          : extractStatus === "running"
            ? "Finding entities"
            : undefined,
      status: extractStatus,
      startedAt: extractJob?.startedAt,
      completedAt: extractJob?.completedAt,
    },
  ];

  const anyRunning = steps.some((s) => s.status === "running");
  const anyActive = anyRunning || estimate?.status === "pending";
  const now = useNow(anyActive);

  const allDone = document.status === "completed" && !anyRunning;
  const errorMessage =
    document.errorMessage ?? document.translationError ??
    (jobs ?? []).find((j) => j.errorMessage)?.errorMessage;

  // Nothing to show for finished docs in compact mode
  if (compact && allDone) return null;
  if (!jobs) return null;

  return (
    <div className={cn("flex flex-col gap-2", !compact && "rounded-lg border bg-card p-3")}>
      {/* One status line, not four. The running step already carries a
          spinner, so the header adds only the words a spinner cannot say. */}
      {!compact && (
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">
            {failed
              ? "Processing failed"
              : allDone
                ? "Processing complete"
                : estimate?.status === "pending"
                  ? "Queued"
                  : "Processing"}
          </h3>
          {estimate && (
            <span
              className="text-xs text-muted-foreground shrink-0"
              title={
                estimate.sampleSize > 0
                  ? `Estimate uses the median of ${estimate.sampleSize} recent ${estimate.stage} run${estimate.sampleSize === 1 ? "" : "s"}.`
                  : "Early estimate; this will improve as more jobs finish."
              }
            >
              {estimateText(estimate, now)}
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
                            ? "text-red-600 dark:text-red-400"
                            : "text-muted-foreground"
                    )}
                  >
                    {step.label}
                  </span>
                  {duration && (
                    <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">
                      {duration}
                    </span>
                  )}
                </div>

                {step.detail && (
                  <p className="text-xs text-muted-foreground leading-snug truncate">
                    {step.detail}
                  </p>
                )}

                {step.note && (
                  <p
                    className={cn(
                      "text-xs leading-snug truncate",
                      step.noteStatus === "failed"
                        ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground"
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
        <p className="text-xs text-red-600 dark:text-red-400 leading-snug">{errorMessage}</p>
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

      {dialog === "extract" && kinds !== undefined && (
        <ExtractRetryDialog
          defaultRoles={extractDefaultRoles(document, kinds)}
          onClose={() => setDialog(null)}
          onRun={async (roles) => {
            await retryExtract({ documentId, roles });
          }}
        />
      )}
    </div>
  );
}

/**
 * The template a retry starts from: what this document's analysis suggested,
 * falling back to the saved template for its kind — the same precedence the
 * review panel uses (ExtractionSetup.tsx).
 */
function extractDefaultRoles(
  document: Doc<"documents">,
  kinds: Doc<"documentKinds">[]
): TemplateRole[] {
  if (document.suggestedRoles && document.suggestedRoles.length > 0) {
    return document.suggestedRoles.map((role) => ({ ...role }));
  }
  const template = kinds.find((k) => k.name === document.primaryKind)
    ?.templateRoles;
  return template ? template.map((r) => ({ ...r })) : [];
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
    <span className="relative h-5 w-5 shrink-0">
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
          "absolute inset-0 flex h-5 w-5 items-center justify-center rounded-full",
          "border-2 border-primary bg-background text-primary",
          "opacity-0 transition-opacity group-hover/step:opacity-100 focus-visible:opacity-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        )}
      >
        <RotateCw className="h-2.5 w-2.5" strokeWidth={3} />
      </button>
    </span>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "running") {
    return <Spinner className="h-5 w-5 text-primary" />;
  }
  if (status === "completed") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white">
        <X className="h-3 w-3" strokeWidth={3} />
      </span>
    );
  }
  if (status === "waiting") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-amber-400 bg-amber-50 dark:bg-amber-950">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
      </span>
    );
  }
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-border bg-background" />
  );
}

import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Check, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import { isAudioVideo, parseStageLabel } from "./DocStatusIndicator";
import { cn } from "@/lib/utils";
import { isCsvDocument } from "@/lib/uploadTypes";
import { languageName } from "@/lib/languages";
import { Button } from "@/components/ui/button";

type StepStatus = "pending" | "running" | "completed" | "failed" | "waiting";

interface Step {
  key: string;
  label: string;
  detail?: string;
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
 * Live pipeline stepper for a document: Upload → Understand → Extract.
 * Understand is one Interfaze completion: OCR and object detection run as
 * precontext before the structured document analysis is returned.
 * Driven by the document status plus per-stage processingJobs, so it updates
 * reactively as the backend advances.
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
  const [retrying, setRetrying] = useState(false);
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
  const translateJob = jobByStage.get("translate");
  const extractJob = jobByStage.get("extract");

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

  const steps: Step[] = [
    {
      key: "upload",
      label: "Upload",
      status: "completed",
    },
    {
      key: "understand",
      label:
        isAudioVideo(document) || isCsvDocument(document)
          ? parseStageLabel(document)
          : "Understand",
      detail:
        parseStatus === "running" && isCsvDocument(document)
          ? "Rows + columns + analysis"
          : parseStatus === "running" && !isAudioVideo(document)
            ? "OCR + objects + analysis"
          : parseDone && (document.pageCount || pages?.length)
            ? isCsvDocument(document)
              ? "CSV parsed"
              : `${document.pageCount ?? pages?.length} page${(document.pageCount ?? pages?.length) === 1 ? "" : "s"}`
          : undefined,
      status:
        parseJob?.status === "canceled" ||
        (failed && parseStatus === "running")
          ? "failed"
          : parseStatus,
      startedAt: parseJob?.startedAt,
      completedAt: parseJob?.completedAt,
    },
    ...(document.translationStatus
      ? [
          {
            key: "translate",
            label: "Translate",
            detail:
              document.translationStatus === "not_needed"
                ? "Already " + languageName(document.sourceLanguageCode)
                : document.translationLanguageCode
                  ? "To " + languageName(document.translationLanguageCode)
                  : undefined,
            status:
              document.translationStatus === "not_needed" ||
              document.translationStatus === "complete"
                ? ("completed" as const)
                : document.translationStatus === "failed"
                  ? ("failed" as const)
                  : document.translationStatus === "translating"
                    ? ("running" as const)
                    : ("pending" as const),
            startedAt: translateJob?.startedAt,
            completedAt: translateJob?.completedAt,
          },
        ]
      : []),
    {
      key: "extract",
      label: "Extract",
      status: extractStatus,
      startedAt: extractJob?.startedAt,
      completedAt: extractJob?.completedAt,
    },
  ];

  const anyRunning = steps.some((s) => s.status === "running");
  const anyActive = anyRunning || estimate?.status === "pending";
  const now = useNow(anyActive);
  const estimatedProgress =
    estimate?.status === "running" && estimate.startedAt
      ? Math.min(
          92,
          Math.max(
            5,
            ((now - estimate.startedAt) / estimate.estimatedDurationMs) * 100
          )
        )
      : undefined;

  const allDone = document.status === "completed" && !anyRunning;
  const errorMessage =
    document.errorMessage ?? document.translationError ??
    (jobs ?? []).find((j) => j.errorMessage)?.errorMessage;

  // Nothing to show for finished docs in compact mode
  if (compact && allDone) return null;
  if (!jobs) return null;

  return (
    <div className={cn("flex flex-col gap-2", !compact && "rounded-lg border bg-card p-3")}>
      {!compact && (
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">
            {failed
              ? "Processing failed"
              : allDone
                ? "Processing complete"
                : estimate?.status === "pending"
                  ? "Queued"
                  : "Processing"}
          </h3>
          {anyActive && <Spinner className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
      )}

      {estimate && (
        <p
          className="text-xs text-muted-foreground"
          title={
            estimate.sampleSize > 0
              ? `Estimate uses the median of ${estimate.sampleSize} recent ${estimate.stage} run${estimate.sampleSize === 1 ? "" : "s"}.`
              : "Early estimate; this will improve as more jobs finish."
          }
        >
          {estimateText(estimate, now)}
        </p>
      )}

      <ol className="flex items-start">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          const duration =
            step.status === "running" && step.startedAt
              ? formatDuration(now - step.startedAt)
              : step.status === "completed" && step.startedAt && step.completedAt
                ? formatDuration(step.completedAt - step.startedAt)
                : null;

          return (
            <li key={step.key} className={cn("flex items-start", !isLast && "flex-1")}>
              <div className="flex flex-col items-center gap-1 min-w-12">
                <StepIcon status={step.status} />
                <span
                  className={cn(
                    "text-[11px] leading-tight",
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
                {(step.detail || duration || step.status === "waiting") && (
                  <span className="text-[10px] text-muted-foreground leading-none truncate max-w-20 text-center">
                    {step.status === "waiting"
                      ? "needs review"
                      : (step.detail ?? duration)}
                  </span>
                )}
              </div>
              {!isLast && (
                <div
                  className={cn(
                    "h-px flex-1 mt-2.5 mx-1 rounded",
                    step.status === "completed" ? "bg-primary/40" : "bg-border"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>

      {anyActive && <Progress className="h-1" value={estimatedProgress} />}

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
    </div>
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

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CirclePause, CirclePlay, OctagonX } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function ProcessingQueueControls() {
  const control = useQuery(api.processingControl.get);
  const setPaused = useMutation(api.processingControl.setPaused);
  const cancelWaiting = useMutation(api.processingControl.cancelWaiting);
  const [busy, setBusy] = useState<"pause" | "resume" | "stop" | null>(null);

  async function togglePaused() {
    if (!control || busy) return;
    const nextPaused = !control.paused;
    setBusy(nextPaused ? "pause" : "resume");
    try {
      await setPaused({ paused: nextPaused });
    } finally {
      setBusy(null);
    }
  }

  async function stopWaiting() {
    if (busy) return;
    const confirmed = window.confirm(
      "Stop every job that is still waiting?\n\n" +
        "The queue will be paused. Jobs already running cannot be interrupted and will finish normally. Canceled documents can be retried."
    );
    if (!confirmed) return;
    setBusy("stop");
    try {
      await cancelWaiting({});
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4 mb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Processing queue</p>
            {control === undefined ? (
              <Skeleton className="h-5 w-16 rounded-full" />
            ) : (
              <span
                className={
                  control.paused
                    ? "rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                    : "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
                }
              >
                {control.paused ? "Paused" : "Running"}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Pausing prevents new Interfaze jobs from starting while preserving
            their place in line. Jobs already running always finish normally.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={control === undefined || busy !== null}
            onClick={() => void togglePaused()}
          >
            {control?.paused ? (
              <CirclePlay data-icon="inline-start" />
            ) : (
              <CirclePause data-icon="inline-start" />
            )}
            {busy === "pause"
              ? "Pausing…"
              : busy === "resume"
                ? "Resuming…"
                : control?.paused
                  ? "Resume queue"
                  : "Pause queue"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={control === undefined || busy !== null}
            onClick={() => void stopWaiting()}
          >
            <OctagonX data-icon="inline-start" />
            {busy === "stop" ? "Stopping…" : "Stop waiting jobs"}
          </Button>
        </div>
      </div>
    </div>
  );
}

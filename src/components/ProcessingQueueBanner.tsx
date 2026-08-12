import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CirclePause, CirclePlay } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";

export function ProcessingQueueBanner() {
  const control = useQuery(api.processingControl.get);
  const setPaused = useMutation(api.processingControl.setPaused);
  const [resuming, setResuming] = useState(false);

  if (!control?.paused) return null;

  return (
    <div
      role="status"
      className="relative z-40 border-b border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/60"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <CirclePause
          className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300"
          aria-hidden
        />
        <p className="min-w-0 flex-1 text-xs text-amber-900 dark:text-amber-100">
          Processing queue paused. Waiting jobs are saved; jobs that were already
          running will finish.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={resuming}
          onClick={async () => {
            setResuming(true);
            try {
              await setPaused({ paused: false });
            } finally {
              setResuming(false);
            }
          }}
        >
          <CirclePlay data-icon="inline-start" />
          {resuming ? "Resuming…" : "Resume"}
        </Button>
      </div>
    </div>
  );
}

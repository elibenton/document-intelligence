import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CirclePause, CirclePlay } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";

export function ProcessingQueueBanner() {
  const control = useQuery(api.processingControl.get);
  // Everyone sees the banner, because a paused queue explains why their upload
  // is sitting still — that is the whole point of it. Only the operator gets
  // the button: one pause flag serves every account, so resuming is a decision
  // about everyone's documents, not the reader's own.
  const isAdmin = useQuery(api.authz.isAdmin);
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
          className="size-4 shrink-0 text-warning"
          aria-hidden
        />
        <p className="min-w-0 flex-1 text-xs text-amber-900 dark:text-amber-100">
          Processing queue paused. Waiting jobs are saved; jobs that were already
          running will finish.
        </p>
        {isAdmin && (
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
        )}
      </div>
    </div>
  );
}

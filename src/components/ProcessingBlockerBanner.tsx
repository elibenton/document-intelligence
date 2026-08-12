import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Global banner for failures that stop ALL document processing rather than
 * one document.
 *
 * Running out of API credits used to surface only as truncated red text on
 * whichever document happened to be parsing — so uploads looked like they
 * were merely failing, with no indication that nothing would ever succeed
 * until someone topped up. This states the cause, the scope, and the fix in
 * one place, on every screen.
 */
export function ProcessingBlockerBanner() {
  const blocker = useQuery(api.documents.processingBlocker);
  const retryBlocked = useMutation(api.processing.retryBlocked);
  const [retrying, setRetrying] = useState(false);

  if (!blocker) return null;

  const outOfCredits = blocker.code === "insufficient_credits";
  const title = outOfCredits
    ? "Document processing stopped — out of API credits"
    : "Document processing stopped — API key rejected";

  const detail = outOfCredits
    ? "Interfaze returned “no credits left”. Nothing will parse or extract until the balance is topped up."
    : "Interfaze rejected the configured key. Update INTERFAZE_API_KEY in the Convex deployment, then retry.";

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 border-b border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/60"
    >
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-red-900 dark:text-red-100">
            {title}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-red-800 dark:text-red-200">
            {detail}{" "}
            {blocker.affectedCount === 1
              ? "1 document is waiting."
              : `${blocker.affectedCount} documents are waiting.`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {outOfCredits && (
            <a
              href="https://interfaze.ai/pricing"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Add credits
              <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </a>
          )}
          <Button
            size="sm"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              try {
                await retryBlocked({});
              } finally {
                setRetrying(false);
              }
            }}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`}
            />
            {retrying ? "Retrying…" : "Retry all"}
          </Button>
        </div>
      </div>
    </div>
  );
}

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { isAudioVideo, parseStageLabel } from "./docStatus";

/**
 * Compact inline status for document list rows: spinner + stage while
 * processing, amber dot when awaiting review, red dot on failure,
 * nothing when completed.
 */
export function DocStatusIndicator({
  status,
  mediaType,
  mimeType,
  reviewSkippedAt,
  className,
}: {
  status: string;
  mediaType?: string;
  mimeType?: string;
  /** Set when the user dismissed this document from the review queue. */
  reviewSkippedAt?: number;
  className?: string;
}) {
  if (status === "completed") return null;

  const activeLabels: Record<string, string> = {
    uploaded: "Queued",
    parsing: isAudioVideo({ mediaType, mimeType })
      ? parseStageLabel({ mediaType, mimeType }, "noun")
      : "Understanding",
    extracting: "Extracting",
  };

  if (status in activeLabels) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 shrink-0",
          className
        )}
      >
        <Spinner className="h-3 w-3" />
        {activeLabels[status]}
      </span>
    );
  }

  // Skipped review: in the library, but nothing was ever extracted from it.
  // Muted and static rather than the pulsing amber of a live queue item —
  // it's a standing fact about the document, not a task shouting for
  // attention. The document page can still extract at any time.
  if (status === "parsed" && reviewSkippedAt !== undefined) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[11px] text-muted-foreground shrink-0",
          className
        )}
        title="Review skipped — nothing has been extracted from this document"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        Not extracted
      </span>
    );
  }

  if (status === "parsed") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 shrink-0",
          className
        )}
        title="Parsed — review the extraction template to continue"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
        Review
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400 shrink-0",
          className
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Failed
      </span>
    );
  }

  return null;
}

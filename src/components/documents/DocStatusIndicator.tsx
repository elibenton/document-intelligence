import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { isCsvDocument } from "@/lib/uploadTypes";

export function isAudioVideo(doc: {
  mediaType?: string;
  mimeType?: string;
}): boolean {
  if (doc.mediaType === "audio" || doc.mediaType === "video") return true;
  return (
    !!doc.mimeType &&
    (doc.mimeType.startsWith("audio/") || doc.mimeType.startsWith("video/"))
  );
}

/** Medium-specific label for the parse stage. */
export function parseStageLabel(
  doc: { mediaType?: string; mimeType?: string },
  form: "noun" | "verb" = "noun"
): string {
  if (isAudioVideo(doc)) {
    return form === "verb" ? "Transcribing" : "Transcribe";
  }
  if (doc.mediaType === "webScrape") {
    return form === "verb" ? "Scraping" : "Scrape";
  }
  if (isCsvDocument(doc)) {
    return form === "verb" ? "Parsing" : "Parse";
  }
  return "OCR";
}

/**
 * Compact inline status for document list rows: spinner + stage while
 * processing, amber dot when awaiting review, red dot on failure,
 * nothing when completed.
 */
export function DocStatusIndicator({
  status,
  mediaType,
  mimeType,
  className,
}: {
  status: string;
  mediaType?: string;
  mimeType?: string;
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

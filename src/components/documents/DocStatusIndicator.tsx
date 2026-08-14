import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { libraryStatus } from "./docStatus";
import type { LibraryStatus } from "./docStatus";

/**
 * Compact inline status for library rows: spinner + stage while the pipeline
 * is working, and nothing at all otherwise. See `libraryStatus` for how a
 * document's state maps onto those words.
 *
 * Failure is deliberately not shown here. It is the one state that isn't
 * progress, and it reads better as a red icon in the row's leading icon slot
 * (HomePage.tsx) than as one more trailing badge — a column of red marks can
 * be scanned down, whereas trailing text has to be read row by row.
 */
export function DocStatusIndicator({
  status,
  mediaType,
  mimeType,
  metadata,
  analyzeStatus,
  className,
}: {
  status: string;
  mediaType?: string;
  mimeType?: string;
  metadata?: string;
  analyzeStatus?: string | null;
  className?: string;
}) {
  const label: LibraryStatus | null = libraryStatus({
    status,
    mediaType,
    mimeType,
    metadata,
    analyzeStatus,
  });
  if (label === null || label === "Failed") return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-2xs text-blue-600 dark:text-blue-400 shrink-0",
        className
      )}
    >
      <Spinner className="size-3" />
      {label}
    </span>
  );
}

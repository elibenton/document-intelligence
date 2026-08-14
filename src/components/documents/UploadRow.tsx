import { AlertCircle, CheckCircle2, Files } from "lucide-react";
import { Link } from "react-router";
import type { UploadItem } from "@/hooks/uploadContext";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Stage values seen while the card is holding work. The first four are the
 * document's own `status` during an upload; "analyze" is the stage an
 * `analyze` card sits at for its whole life, since the document's status does
 * not move while the pass re-runs.
 */
const STAGE_LABELS: Record<string, string> = {
  uploaded: "Queued…",
  parsing: "Reading document…",
  parsed: "Analyzing…",
  extracting: "Extracting…",
  analyze: "Re-analyzing…",
};

function statusText(item: UploadItem): string {
  switch (item.status) {
    case "preflighting":
      return "Checking file…";
    case "converting":
      return `Optimizing audio… ${item.progress}%`;
    case "uploading":
      return `${item.progress}% of ${formatBytes(item.size)}`;
    case "finalizing":
      return "Starting analysis…";
    case "ingesting":
      return STAGE_LABELS[item.stage ?? ""] ?? "Processing…";
    case "done":
      return "Ready";
    case "duplicate":
      return "Already added";
    default:
      return "Failed";
  }
}

export function UploadRow({ item }: { item: UploadItem }) {
  const showProgress =
    item.status === "converting" ||
    item.status === "uploading" ||
    item.status === "finalizing" ||
    item.status === "ingesting";

  return (
    <div className="rounded-lg border bg-card px-3 py-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {item.status === "done" ? (
          <CheckCircle2 className="size-4 shrink-0 text-green-600 dark:text-green-400" />
        ) : item.status === "error" ? (
          <AlertCircle className="size-4 shrink-0 text-destructive" />
        ) : item.status === "duplicate" ? (
          <Files className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Spinner className="size-4 shrink-0 text-primary" />
        )}
        {item.documentId && item.status !== "error" ? (
          <Link
            to={`/documents/${item.documentId}`}
            className="text-sm truncate flex-1 hover:underline"
          >
            {item.name}
          </Link>
        ) : (
          <span className="text-sm truncate flex-1">{item.name}</span>
        )}
        <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
          {statusText(item)}
        </span>
      </div>
      {showProgress && (
        <Progress
          className="h-1"
          value={
            item.status === "finalizing" || item.status === "ingesting"
              ? undefined
              : item.progress
          }
        />
      )}
      {item.status === "error" && item.error && (
        <p className="text-xs text-destructive">{item.error}</p>
      )}
      {item.status !== "error" && item.detail && (
        <p className="text-xs text-muted-foreground">{item.detail}</p>
      )}
      {item.status !== "error" &&
        item.warnings?.map((warning) => (
          <p
            key={warning}
            className="text-xs text-warning"
          >
            {warning}
          </p>
        ))}
    </div>
  );
}

import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { parseStageLabel } from "./docStatus";
import { DocTypeIcon } from "./DocTypeIcon";
import { DocumentActions } from "./DocumentActions";
import type { Doc } from "../../../convex/_generated/dataModel";
import { ProcessingEstimate } from "./PipelineProgress";

const statusColors: Record<string, string> = {
  uploaded: "bg-muted text-muted-foreground",
  parsing: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  parsed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  extracting: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  completed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

function statusLabel(document: Doc<"documents">): string {
  switch (document.status) {
    case "uploaded":
      return "Queued";
    case "parsing":
      return parseStageLabel(document, "verb");
    case "parsed":
      return "Needs review";
    case "extracting":
      return "Extracting";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return document.status;
  }
}

const ACTIVE_STATUSES = new Set(["uploaded", "parsing", "extracting"]);

export function DocumentCard({ document }: { document: Doc<"documents"> }) {
  const isActive = ACTIVE_STATUSES.has(document.status);

  return (
    <Card className="hover:bg-accent/50 transition-colors overflow-hidden">
      <CardHeader className="p-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <Link to={`/documents/${document._id}`} className="min-w-0 flex-1">
            <CardTitle className="text-sm font-medium truncate cursor-pointer hover:underline flex items-center gap-1.5">
              <DocTypeIcon
                mediaType={document.mediaType}
                mimeType={document.mimeType}
              />
              <span className="truncate">{document.name}</span>
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              {new Date(document.uploadedAt).toLocaleDateString()}
              {document.pageCount && ` · ${document.pageCount} pages`}
            </CardDescription>
            {isActive && (
              <ProcessingEstimate
                documentId={document._id}
                className="block text-xs text-muted-foreground mt-1"
              />
            )}
            {document.status === "failed" && document.errorMessage && (
              // Account-level blockers (no credits, bad key) tell the user
              // what to go fix, so they wrap instead of truncating — the
              // actionable half of the sentence is at the end.
              <p
                className={
                  document.errorCode
                    ? "text-xs text-red-600 mt-1 leading-snug"
                    : "text-xs text-red-600 mt-1 truncate"
                }
              >
                {document.errorMessage}
              </p>
            )}
          </Link>
          <div className="flex items-center gap-1.5 shrink-0">
            <Badge
              variant="secondary"
              className={statusColors[document.status] ?? ""}
            >
              {isActive && <Spinner className="h-3 w-3 mr-1" />}
              {statusLabel(document)}
            </Badge>
            <DocumentActions
              documentId={document._id}
              documentName={document.name}
              archived={document.archivedAt !== undefined}
            />
          </div>
        </div>
      </CardHeader>
      {isActive && <Progress className="h-0.5 rounded-none" />}
    </Card>
  );
}

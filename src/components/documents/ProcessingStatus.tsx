import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import type { Id } from "../../../convex/_generated/dataModel";

const stageLabels: Record<string, string> = {
  parse: "Parse",
  extract: "Extract",
};

const statusStyles: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-100 text-blue-800 animate-pulse",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export function ProcessingStatus({ documentId }: { documentId: Id<"documents"> }) {
  const jobs = useQuery(api.processingJobs.byDocument, { documentId });

  if (!jobs || jobs.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Processing</h3>
      <div className="flex flex-wrap gap-2">
        {jobs.map((job) => (
          <Badge
            key={job._id}
            variant="secondary"
            className={statusStyles[job.status] ?? ""}
          >
            {stageLabels[job.stage] ?? job.stage}: {job.status}
            {job.progress != null && ` (${job.progress}%)`}
          </Badge>
        ))}
      </div>
      {jobs.some((j) => j.errorMessage) && (
        <p className="text-xs text-red-600">
          {jobs.find((j) => j.errorMessage)?.errorMessage}
        </p>
      )}
    </div>
  );
}

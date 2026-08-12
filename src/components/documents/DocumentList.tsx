import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { DocumentCard } from "./DocumentCard";
import { UploadButton } from "./UploadButton";
import { Skeleton } from "@/components/ui/skeleton";
import type { Id } from "../../../convex/_generated/dataModel";

export function DocumentList({ projectId }: { projectId: Id<"projects"> }) {
  const documents = useQuery(api.documents.list, { projectId });
  const archived = useQuery(api.documents.listArchived, { projectId });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Documents</h2>
        <UploadButton projectId={projectId} />
      </div>
      <div className="flex flex-col gap-2">
        {documents === undefined ? (
          <>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </>
        ) : documents.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No documents yet. Upload a PDF, CSV, image, audio, or video file to get started.
          </p>
        ) : (
          documents.map((doc) => (
            <DocumentCard key={doc._id} document={doc} />
          ))
        )}
      </div>

      {archived && archived.length > 0 && (
        <details className="group mt-2">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground list-none [&::-webkit-details-marker]:hidden">
            <span className="inline-block transition-transform group-open:rotate-90 mr-1">
              ›
            </span>
            Archived ({archived.length})
          </summary>
          <div className="flex flex-col gap-2 mt-2 opacity-70">
            {archived.map((doc) => (
              <DocumentCard key={doc._id} document={doc} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

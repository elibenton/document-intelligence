import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { DocumentCard } from "./DocumentCard";
import { UploadButton } from "./UploadButton";
import { Skeleton } from "@/components/ui/skeleton";

export function DocumentList() {
  const documents = useQuery(api.documents.list);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Documents</h2>
        <UploadButton />
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
            No documents yet. Upload a PDF to get started.
          </p>
        ) : (
          documents.map((doc) => (
            <DocumentCard key={doc._id} document={doc} />
          ))
        )}
      </div>
    </div>
  );
}

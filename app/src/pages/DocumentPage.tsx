import { useParams, Link } from "react-router-dom";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { PdfViewer } from "@/components/viewer/PdfViewer";
import { ViewerLayout } from "@/components/viewer/ViewerLayout";
import { ProcessingStatus } from "@/components/documents/ProcessingStatus";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Id } from "../../convex/_generated/dataModel";

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const documentId = id as Id<"documents">;
  const document = useQuery(api.documents.get, { id: documentId });
  const url = useQuery(
    api.documents.getUrl,
    document ? { storageId: document.storageId } : "skip"
  );
  const triggerPipeline = useAction(api.processing.triggerPipeline);

  if (document === undefined) {
    return (
      <div className="p-8">
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  if (document === null) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">Document not found.</p>
        <Link to="/">
          <Button variant="outline" className="mt-4">Back to Home</Button>
        </Link>
      </div>
    );
  }

  async function handleProcess() {
    try {
      await triggerPipeline({ documentId });
    } catch (err) {
      console.error("Failed to trigger processing:", err);
    }
  }

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b px-6 py-3 flex items-center gap-4">
        <Link to="/">
          <Button variant="ghost" size="sm">&larr; Back</Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold truncate">{document.name}</h1>
        </div>
        {document.status === "uploaded" && (
          <Button size="sm" onClick={handleProcess}>
            Process Document
          </Button>
        )}
      </header>
      <div className="flex-1 overflow-hidden">
        <ViewerLayout
          viewer={
            url ? (
              <PdfViewer url={url} />
            ) : (
              <div className="flex items-center justify-center h-96">
                <p className="text-muted-foreground">Loading PDF...</p>
              </div>
            )
          }
          sidebar={
            <div className="flex flex-col gap-4">
              <ProcessingStatus documentId={documentId} />
              <div>
                <h3 className="text-sm font-medium mb-2">Entities</h3>
                <p className="text-xs text-muted-foreground">
                  {document.status === "completed"
                    ? "Entities will appear here after NER processing."
                    : "Upload and process this document to extract entities."}
                </p>
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}

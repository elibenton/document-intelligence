import { useMutation } from "convex/react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * Archive/restore + delete controls for a document. Archive is
 * non-destructive (hides the document from the main list); delete removes
 * the file and every derived row (pages, blocks, mentions, extractions…)
 * behind a confirm prompt.
 */
export function DocumentActions({
  documentId,
  documentName,
  archived,
  onDeleted,
  className,
}: {
  documentId: Id<"documents">;
  documentName: string;
  archived: boolean;
  onDeleted?: () => void;
  className?: string;
}) {
  const setArchived = useMutation(api.documents.setArchived);
  const removeDocument = useMutation(api.documents.remove);

  return (
    <span className={className}>
      <Button
        variant="ghost"
        size="icon-xs"
        title={archived ? "Restore from archive" : "Archive"}
        className="text-muted-foreground hover:text-foreground"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setArchived({ id: documentId, archived: !archived });
        }}
      >
        {archived ? (
          <ArchiveRestore className="h-3.5 w-3.5" />
        ) : (
          <Archive className="h-3.5 w-3.5" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Delete permanently"
        className="text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-950/40"
        onClick={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (
            window.confirm(
              `Permanently delete "${documentName}" and all of its extracted data? This cannot be undone.`
            )
          ) {
            await removeDocument({ id: documentId });
            onDeleted?.();
          }
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
}

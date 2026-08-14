import { useMutation } from "convex/react";
import { Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import type { Id } from "../../../convex/_generated/dataModel";
import { useConfirm } from "@/components/ui/use-confirm";

/**
 * Delete control for a document: removes the file and every derived row
 * (pages, blocks, mentions, extractions…) behind a confirm prompt.
 */
export function DocumentActions({
  documentId,
  documentName,
  onDeleted,
  className,
}: {
  documentId: Id<"documents">;
  documentName: string;
  onDeleted?: () => void;
  className?: string;
}) {
  const removeDocument = useMutation(api.documents.remove);
  const confirm = useConfirm();

  return (
    <span className={className}>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Delete permanently"
        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        onClick={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const ok = await confirm({
            title: `Permanently delete “${documentName}”?`,
            body: "This removes the document and everything extracted from it. It cannot be undone.",
            confirmLabel: "Delete permanently",
            tone: "destructive",
          });
          if (!ok) return;
          await removeDocument({ id: documentId });
          onDeleted?.();
        }}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </span>
  );
}

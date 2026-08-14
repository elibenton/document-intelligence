import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FolderInput, FolderOpen } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { counted } from "@/lib/plural";

/**
 * Move a document to another project.
 *
 * The warning is the point of this dialog. Moving is cheap and reversible for
 * the document itself, but a project owns its taxonomy, so the category the
 * document was filed under may not exist where it is going — and re-analyzing
 * is the only honest way to re-file it. Saying so here is what keeps the
 * category quietly disappearing from being a surprise.
 *
 * The entity graph moves with the document and needs no warning: mentions,
 * roles and relationships are repointed onto same-named entities in the target
 * project, and nothing is re-extracted.
 *
 * The trigger lives inside rather than being hoisted to the caller, because
 * opening this from a plain button's `onClick` does not work: Base UI arms an
 * outside-press listener as the dialog opens, the click that opened it is still
 * propagating, and the dialog closes again in the same tick. `DialogTrigger` is
 * what tells the primitive which element it was opened from.
 */
export function MoveDocumentDialog({
  documentId,
  documentName,
  currentProjectId,
  onMoved,
}: {
  documentId: Id<"documents">;
  documentName: string;
  currentProjectId?: Id<"projects">;
  onMoved?: () => void;
}) {
  const projects = useQuery(api.projects.list);
  const moveToProject = useMutation(api.documentMove.moveToProject);

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Id<"projects"> | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = (projects ?? []).filter((p) => p._id !== currentProjectId);

  async function move() {
    if (!selected || moving) return;
    setMoving(true);
    setError(null);
    try {
      await moveToProject({ documentId, targetProjectId: selected });
      setOpen(false);
      onMoved?.();
    } catch (e) {
      // The one failure a user can actually act on is the duplicate check:
      // the target already holds this exact file. Show what the mutation said.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSelected(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            title="Move to another project"
            aria-label="Move to another project"
            className="text-muted-foreground"
          />
        }
      >
        <FolderInput className="size-3.5" />
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <div className="grid gap-1.5">
          <DialogTitle>Move “{documentName}”</DialogTitle>
          <DialogDescription>
            Its pages, notes and entity connections move with it. The category
            it is filed under belongs to its current project — re-analyze the
            document afterwards to re-file it here.
          </DialogDescription>
        </div>

        {projects === undefined ? (
          <div className="grid gap-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : choices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There is nowhere to move it — this is the only project.
          </p>
        ) : (
          <div className="grid max-h-64 gap-1.5 overflow-y-auto">
            {choices.map((project) => (
              <button
                key={project._id}
                type="button"
                aria-pressed={selected === project._id}
                onClick={() => setSelected(project._id)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
                  selected === project._id
                    ? "border-foreground bg-accent"
                    : "hover:bg-accent/50"
                )}
              >
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {project.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {project.documentCount >= 500
                      ? "500+ documents"
                      : counted(project.documentCount, "document")}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <DialogClose
            render={
              <Button type="button" variant="ghost" size="sm" disabled={moving} />
            }
          >
            Cancel
          </DialogClose>
          <Button
            type="button"
            size="sm"
            disabled={!selected || moving}
            onClick={() => void move()}
          >
            {moving ? "Moving…" : "Move document"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from "react";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface MergeCandidate {
  _id: Id<"entities">;
  name: string;
  mentionCount: number;
}

/** The backend's pickSurvivor, mirrored: more evidence, then the fuller name. */
function defaultSurvivor(
  a: MergeCandidate,
  b: MergeCandidate
): Id<"entities"> {
  if (a.mentionCount !== b.mentionCount) {
    return a.mentionCount > b.mentionCount ? a._id : b._id;
  }
  return a.name.length >= b.name.length ? a._id : b._id;
}

/**
 * The merge confirmation: pick which name survives — the other becomes an
 * alias, so nothing stops matching. One dialog for every way a merge starts:
 * accepting a resolver suggestion (MergeSuggestions) and dragging one entity
 * onto another in the document sidebar.
 *
 * Keyed remount per pair (the parent passes a fresh `pair`), so the radio
 * seed re-derives for each merge rather than carrying the previous choice.
 */
export function EntityMergeDialog({
  pair,
  description,
  error,
  busy,
  onMerge,
  onClose,
}: {
  pair: { a: MergeCandidate; b: MergeCandidate } | null;
  /** Why these two are believed to be one — the resolver's reason, or the
   *  drag's own framing. */
  description: string;
  /** A failed attempt's message, shown in place so the user can retry. */
  error?: string | null;
  busy: boolean;
  onMerge: (keepEntityId: Id<"entities">) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={pair !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {pair && (
        <MergeDialogBody
          key={`${pair.a._id}:${pair.b._id}`}
          pair={pair}
          description={description}
          error={error}
          busy={busy}
          onMerge={onMerge}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function MergeDialogBody({
  pair,
  description,
  error,
  busy,
  onMerge,
  onClose,
}: {
  pair: { a: MergeCandidate; b: MergeCandidate };
  description: string;
  error?: string | null;
  busy: boolean;
  onMerge: (keepEntityId: Id<"entities">) => void;
  onClose: () => void;
}) {
  const [keepId, setKeepId] = useState<Id<"entities">>(() =>
    defaultSurvivor(pair.a, pair.b)
  );
  return (
    <DialogContent className="max-w-md">
      <DialogTitle>Merge into one entity?</DialogTitle>
      <DialogDescription>
        {description} Pick which name survives — the other becomes an alias,
        so nothing stops matching. Undo is available for 30 days.
      </DialogDescription>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 flex flex-col gap-1.5">
        {[pair.a, pair.b].map((entity) => (
          <label
            key={entity._id}
            className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-checked:border-primary"
          >
            <input
              type="radio"
              name="merge-survivor"
              checked={keepId === entity._id}
              onChange={() => setKeepId(entity._id)}
              className="accent-primary"
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              {entity.name}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {entity.mentionCount} mention
              {entity.mentionCount !== 1 && "s"}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onMerge(keepId)}>
          {busy ? "Merging…" : "Merge"}
        </Button>
      </div>
    </DialogContent>
  );
}

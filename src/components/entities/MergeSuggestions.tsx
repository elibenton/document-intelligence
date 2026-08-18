import { useState } from "react";
import { useMutation } from "convex/react";
import { ChevronRight, Undo2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type MergeSuggestion = {
  _id: Id<"mergeSuggestions">;
  reason: string;
  confidence: number | null;
  source: {
    _id: Id<"entities">;
    name: string;
    mentionCount: number;
  };
  target: {
    _id: Id<"entities">;
    name: string;
    mentionCount: number;
  };
  documentName: string | null;
};

type UndoState = {
  mergeLogId: Id<"mergeLog">;
  survivorName: string;
  mergedName: string;
};

/**
 * Pending "same entity?" suggestions from the fuzzy resolver, for one
 * project. Merging goes through a confirm dialog that shows the resolver's
 * evidence and lets the human pick which name survives — the loser's name
 * is taught as an alias either way, so the choice is about display, not
 * information. A just-completed merge offers a one-click undo (available
 * for 30 days from the entity page later; here for the immediate oops).
 */
export function MergeSuggestions({
  suggestions,
}: {
  suggestions: MergeSuggestion[];
}) {
  const accept = useMutation(api.mergeSuggestions.accept);
  const reject = useMutation(api.mergeSuggestions.reject);
  const unmerge = useMutation(api.mergeSuggestions.unmerge);

  const [confirming, setConfirming] = useState<MergeSuggestion | null>(null);
  const [keepId, setKeepId] = useState<Id<"entities"> | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [busy, setBusy] = useState(false);

  if (suggestions.length === 0 && !undo) return null;

  function openConfirm(s: MergeSuggestion) {
    setConfirming(s);
    // Default survivor mirrors the backend's pickSurvivor: more evidence,
    // then the fuller name.
    const def =
      s.source.mentionCount !== s.target.mentionCount
        ? s.source.mentionCount > s.target.mentionCount
          ? s.source._id
          : s.target._id
        : s.source.name.length >= s.target.name.length
          ? s.source._id
          : s.target._id;
    setKeepId(def);
  }

  async function runMerge() {
    if (!confirming || !keepId || busy) return;
    setBusy(true);
    try {
      const result = await accept({ id: confirming._id, keepEntityId: keepId });
      if (result?.mergeLogId) {
        const survivor =
          keepId === confirming.source._id ? confirming.source : confirming.target;
        const merged =
          keepId === confirming.source._id ? confirming.target : confirming.source;
        setUndo({
          mergeLogId: result.mergeLogId,
          survivorName: survivor.name,
          mergedName: merged.name,
        });
      }
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {undo && (
        <div className="mt-1 flex items-center justify-between gap-2 rounded-md border bg-card px-2 py-1.5 text-xs">
          <span className="min-w-0 truncate text-muted-foreground">
            Merged <span className="font-medium text-foreground">{undo.mergedName}</span> into{" "}
            <span className="font-medium text-foreground">{undo.survivorName}</span>
          </span>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => {
              void unmerge({ logId: undo.mergeLogId });
              setUndo(null);
            }}
          >
            <Undo2 className="size-3" />
            Undo
          </button>
        </div>
      )}
      {suggestions.length > 0 && (
        <details className="group/duplicates mt-1 rounded-md border border-amber-200/80 bg-amber-50/50 dark:border-amber-900/80 dark:bg-amber-950/20">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-100/60 dark:text-amber-100 dark:hover:bg-amber-950/40 [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 items-center gap-1.5">
              <ChevronRight className="size-3 shrink-0 text-amber-700 transition-transform group-open/duplicates:rotate-90 dark:text-amber-300" />
              <span className="truncate">Possible duplicates</span>
            </span>
            <span className="shrink-0 tabular-nums text-warning">
              {suggestions.length}
            </span>
          </summary>
          <div className="flex flex-col gap-2 border-t border-amber-200/80 p-2 dark:border-amber-900/80">
            {suggestions.map((s) => (
              <div key={s._id} className="flex flex-col gap-1 text-xs">
                <div className="min-w-0">
                  <span className="font-medium">{s.source.name}</span>
                  <span className="text-muted-foreground"> = </span>
                  <span className="font-medium">{s.target.name}</span>
                </div>
                {/* The resolver's evidence, finally shown: why it thinks
                    these are one entity, and where the pair surfaced. */}
                <p className="text-2xs text-muted-foreground">
                  {s.reason}
                  {s.documentName ? ` · found in ${s.documentName}` : ""}
                </p>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => openConfirm(s)}
                    className="rounded border bg-background px-2 py-1 text-xs hover:bg-accent"
                  >
                    Merge…
                  </button>
                  <button
                    type="button"
                    onClick={() => reject({ id: s._id })}
                    className="rounded border bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                    title="Keep as separate entities"
                  >
                    Keep separate
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        {confirming && (
          <DialogContent className="max-w-md">
            <DialogTitle>Merge into one entity?</DialogTitle>
            <DialogDescription>
              {confirming.reason}. Pick which name survives — the other
              becomes an alias, so nothing stops matching. Undo is available
              for 30 days.
            </DialogDescription>
            <div className="mt-3 flex flex-col gap-1.5">
              {[confirming.source, confirming.target].map((entity) => (
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(null)}
              >
                Cancel
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void runMerge()}>
                {busy ? "Merging…" : "Merge"}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

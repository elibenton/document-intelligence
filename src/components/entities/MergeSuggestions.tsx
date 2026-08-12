import { useMutation } from "convex/react";
import { ChevronRight } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

export type MergeSuggestion = {
  _id: Id<"mergeSuggestions">;
  reason: string;
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

/**
 * Pending "same entity?" suggestions from the fuzzy resolver, for one project.
 * Accepting merges the newer entity into the existing one and teaches the
 * alias; rejecting remembers the pair so it is never re-suggested.
 */
export function MergeSuggestions({
  suggestions,
}: {
  suggestions: MergeSuggestion[];
}) {
  const accept = useMutation(api.mergeSuggestions.accept);
  const reject = useMutation(api.mergeSuggestions.reject);

  if (suggestions.length === 0) return null;

  return (
    <details className="group/duplicates mt-1 rounded-md border border-amber-200/80 bg-amber-50/50 dark:border-amber-900/80 dark:bg-amber-950/20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-100/60 dark:text-amber-100 dark:hover:bg-amber-950/40 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight className="h-3 w-3 shrink-0 text-amber-700 transition-transform group-open/duplicates:rotate-90 dark:text-amber-300" />
          <span className="truncate">Possible duplicates</span>
        </span>
        <span className="shrink-0 tabular-nums text-amber-700 dark:text-amber-300">
          {suggestions.length}
        </span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-amber-200/80 p-2 dark:border-amber-900/80">
        {suggestions.map((s) => (
          <div
            key={s._id}
            className="flex flex-col gap-1.5 text-xs"
          >
            <div className="min-w-0">
              <span className="font-medium">{s.source.name}</span>
              <span className="text-muted-foreground"> = </span>
              <span className="font-medium">{s.target.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {" "}
                ({s.target.mentionCount} mentions
                {s.documentName ? ` · found in ${s.documentName}` : ""})
              </span>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => accept({ id: s._id })}
                className="rounded border bg-background px-2 py-1 text-xs hover:bg-accent"
                title={`Merge "${s.source.name}" into "${s.target.name}"`}
              >
                Merge
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
  );
}

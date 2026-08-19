import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { annotationColor } from "./annotationColors";
import { formatTime } from "@/components/recordings/speakerColors";

/**
 * Every highlight and comment on the document, in reading order, grouped under
 * the section each was made in.
 *
 * The section comes off the row, not from re-deriving it against the current
 * outline: a note is filed under the heading the user saw it under, and a
 * re-analyzed document must not silently refile old notes.
 */
export function NotesPanel({
  documentId,
  activeId,
  onActivate,
  onNavigate,
  onSeek,
}: {
  documentId: Id<"documents">;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  /** Scroll the viewer to a 1-indexed page. */
  onNavigate: (pageNumber: number) => void;
  /** Recordings: seek playback instead of scrolling — a time-anchored note
   *  navigates by seconds, not pages. */
  onSeek?: (seconds: number) => void;
}) {
  const annotations = useQuery(api.annotations.byDocument, { documentId });
  const removeAnnotation = useMutation(api.annotations.remove);

  // Rows arrive in reading order, so runs of the same section are already
  // adjacent — grouping is a fold, not a sort.
  const groups = useMemo(() => {
    const out: Array<{ title: string | null; notes: Doc<"annotations">[] }> = [];
    for (const note of annotations ?? []) {
      const title = note.sectionTitle ?? null;
      const last = out[out.length - 1];
      if (last && last.title === title) last.notes.push(note);
      else out.push({ title, notes: [note] });
    }
    return out;
  }, [annotations]);

  if (annotations === undefined) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Loading notes…
      </p>
    );
  }

  if (annotations.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Select text in the document to highlight it or leave a comment. Your
        notes collect here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group, index) => (
        <div key={`${group.title ?? "untitled"}:${index}`} className="flex flex-col gap-1.5">
          <h3 className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.title ?? "Unsectioned"}
          </h3>
          {group.notes.map((note) => (
            <NoteRow
              key={note._id}
              note={note}
              active={note._id === activeId}
              onSelect={() => {
                if (note.timeRange && onSeek) onSeek(note.timeRange.start);
                else onNavigate(note.pageNumber + 1);
                onActivate(note._id);
              }}
              onDelete={() => {
                if (note._id === activeId) onActivate(null);
                void removeAnnotation({ id: note._id });
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function NoteRow({
  note,
  active,
  onSelect,
  onDelete,
}: {
  note: Doc<"annotations">;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const updateAnnotation = useMutation(api.annotations.update);
  // Commenting happens inline, right here in the panel — it must not
  // navigate the viewer back to the highlight. null = not editing.
  const [draft, setDraft] = useState<string | null>(null);
  const color = annotationColor(note.color);

  const commit = () => {
    if (draft === null) return;
    const comment = draft.trim();
    if (comment !== (note.comment ?? "").trim()) {
      void updateAnnotation({ id: note._id, comment });
    }
    setDraft(null);
  };

  return (
    <div
      className={cn(
        "group/note relative rounded-md border transition-colors",
        active ? "border-foreground/30 bg-accent" : "hover:bg-accent/50"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full flex-col items-start gap-1 px-2.5 pt-2 text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring rounded-md"
      >
        {/* pr-8 keeps the quote clear of the hover trash button overlaid in
            the row's top-right corner. */}
        <span className="flex w-full items-start gap-2 pr-8">
          <span
            aria-hidden="true"
            className="mt-1 size-3 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
            style={{ backgroundColor: color.swatch }}
          />
          <span className="line-clamp-3 flex-1 text-xs italic text-muted-foreground">
            “{note.text}”
          </span>
        </span>
        {note.comment && draft === null && (
          <span className="w-full whitespace-pre-wrap pl-4.5 text-sm text-foreground">
            {note.comment}
          </span>
        )}
      </button>

      {draft !== null && (
        <div className="px-2.5 pl-7 pt-1">
          <textarea
            value={draft}
            autoFocus
            rows={2}
            placeholder="Add a comment…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(null);
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commit();
              }
            }}
            className={cn(
              "w-full resize-none rounded-md border bg-background px-2 py-1 text-sm",
              "placeholder:text-muted-foreground",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
            )}
          />
        </div>
      )}

      {/* Footer: the address on the left, the quiet comment control on the
          right. Siblings of the main button, so neither click navigates. */}
      <div className="flex items-center justify-between pb-1.5 pl-7 pr-2">
        <span className="text-2xs text-muted-foreground">
          {note.timeRange
            ? formatTime(note.timeRange.start)
            : `Page ${note.pageNumber + 1}`}
        </span>
        <button
          type="button"
          onClick={() =>
            draft === null ? setDraft(note.comment ?? "") : commit()
          }
          className={cn(
            "rounded px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
          )}
        >
          {draft !== null ? "Save" : note.comment ? "Edit" : "Comment"}
        </button>
      </div>

      <button
        type="button"
        onClick={onDelete}
        title="Delete note"
        aria-label="Delete note"
        className={cn(
          "absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md",
          "text-muted-foreground opacity-0 transition-opacity hover:text-destructive",
          "group-hover/note:opacity-100 focus-visible:opacity-100",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        )}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

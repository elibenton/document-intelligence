import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { documentTitles } from "@/lib/documentTitle";
import { cn } from "@/lib/utils";

interface Suggestion {
  label: string;
  prompt: string;
  rationale: string;
}

/** The key a suggestion becomes in the extraction schema. */
function keyOf(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "_") || "extraction";
}

/**
 * Extraction review — the step between Analyze and the library.
 *
 * Analyze already read the whole document and proposed what is worth pulling
 * out of it; this is where the user accepts, edits, or replaces those
 * proposals. It opens from the Sources list: an unreviewed source goes to its
 * review rather than straight to the viewer. Skipping is allowed (documents
 * shouldn't be held hostage by a review step), but a skipped document is
 * flagged in the library rather than quietly passing as extracted.
 */
export function ReviewDialog({
  document,
  onClose,
}: {
  document: Doc<"documents">;
  onClose: () => void;
}) {
  // Escape closes, the way every other dismissible layer behaves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Review ${documentTitles(document).primary}`}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 pt-[10vh]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border bg-card shadow-lg">
        <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Review extraction</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close review"
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <ReviewPanel key={document._id} document={document} onDone={onClose} />
      </div>
    </div>
  );
}

function ReviewPanel({
  document,
  onDone,
}: {
  document: Doc<"documents">;
  onDone: () => void;
}) {
  const runExtraction = useAction(api.processing.runExtraction);
  const runAnalyze = useAction(api.processing.runAnalyze);
  const skipReview = useMutation(api.documents.skipReview);
  const [reanalyzing, setReanalyzing] = useState(false);

  const suggestions = useMemo<Suggestion[]>(
    () => document.suggestedExtractions ?? [],
    [document.suggestedExtractions]
  );

  // Everything Analyze proposed starts selected: the common path is "yes, run
  // these", and unchecking is cheaper than rebuilding the list by hand.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(suggestions.map((s) => s.label))
  );
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [extras, setExtras] = useState<Suggestion[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all = [...suggestions, ...extras];
  const chosen = all.filter((s) => selected.has(s.label));
  const { primary, original } = documentTitles(document);

  function toggle(label: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function addCustom() {
    const label = newLabel.trim();
    const prompt = newPrompt.trim();
    if (!label || !prompt) return;
    setExtras((prev) => [...prev, { label, prompt, rationale: "" }]);
    setSelected((prev) => new Set(prev).add(label));
    setNewLabel("");
    setNewPrompt("");
  }

  /**
   * One extraction covering every chosen suggestion, not one run per pill:
   * a document may only have one extract job in flight, and a single schema
   * with several properties reads the document once instead of N times.
   */
  async function run() {
    if (chosen.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const properties: Record<string, unknown> = {};
      for (const suggestion of chosen) {
        properties[keyOf(suggestion.label)] = {
          type: "array",
          items: { type: "string" },
          description: edits[suggestion.label] ?? suggestion.prompt,
        };
      }
      await runExtraction({
        documentId: document._id,
        pageSchema: JSON.stringify({
          type: "object",
          properties,
          required: Object.keys(properties),
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="min-w-0">
        <Link
          to={`/documents/${document._id}`}
          className="text-sm font-medium hover:underline block truncate"
        >
          {primary}
        </Link>
        {original && (
          <p className="text-xs text-muted-foreground truncate">{original}</p>
        )}
      </div>

      {suggestions.length === 0 ? (
        // Either Analyze found nothing worth proposing, or the document was
        // analyzed before suggestions existed. Re-running Analyze is cheap
        // (text in, no re-scan) and is the only way to tell the two apart.
        <p className="text-xs text-muted-foreground">
          No suggestions for this document.{" "}
          <button
            onClick={() => {
              setReanalyzing(true);
              void runAnalyze({ documentId: document._id }).finally(() =>
                setReanalyzing(false)
              );
            }}
            disabled={reanalyzing}
            className="underline hover:text-foreground disabled:no-underline"
          >
            {reanalyzing ? "Analyzing…" : "Re-run Analyze"}
          </button>{" "}
          for some, or add your own below.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {all.map((suggestion) => {
            const isSelected = selected.has(suggestion.label);
            return (
              <span key={suggestion.label} className="flex items-stretch">
                <button
                  onClick={() => toggle(suggestion.label)}
                  title={suggestion.rationale || suggestion.prompt}
                  className={cn(
                    "text-xs pl-2 pr-1.5 py-1 rounded-l-md border border-r-0 transition-colors",
                    isSelected
                      ? "bg-primary/10 border-primary/40 text-foreground"
                      : "bg-background hover:bg-accent text-muted-foreground"
                  )}
                >
                  {suggestion.label}
                </button>
                <button
                  onClick={() =>
                    setEditing((current) =>
                      current === suggestion.label ? null : suggestion.label
                    )
                  }
                  title="Edit the prompt"
                  className={cn(
                    "text-xs px-1.5 rounded-r-md border transition-colors",
                    editing === suggestion.label
                      ? "bg-accent text-foreground"
                      : "bg-background hover:bg-accent text-muted-foreground"
                  )}
                >
                  ✎
                </button>
              </span>
            );
          })}
        </div>
      )}

      {editing && (
        <textarea
          value={
            edits[editing] ??
            all.find((s) => s.label === editing)?.prompt ??
            ""
          }
          onChange={(e) =>
            setEdits((prev) => ({ ...prev, [editing]: e.target.value }))
          }
          rows={3}
          className="w-full rounded-md border bg-background p-2 text-xs outline-none focus:ring-1 focus:ring-primary"
        />
      )}

      <div className="flex flex-col gap-1.5">
        <Input
          value={newLabel}
          placeholder="Add your own (e.g. Deadlines)"
          onChange={(e) => setNewLabel(e.target.value)}
          className="text-xs h-7"
        />
        {newLabel.trim() && (
          <div className="flex gap-1.5">
            <Input
              value={newPrompt}
              placeholder="What should it pull out?"
              onChange={(e) => setNewPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCustom()}
              className="text-xs h-7"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={addCustom}
              disabled={!newPrompt.trim()}
              className="h-7 shrink-0"
            >
              Add
            </Button>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => void run()}
          disabled={running || chosen.length === 0}
        >
          {running ? (
            <span className="flex items-center gap-1.5">
              <Spinner className="h-3.5 w-3.5" />
              Starting…
            </span>
          ) : (
            `Extract ${chosen.length}`
          )}
        </Button>
        <button
          onClick={() => {
            void skipReview({ documentId: document._id });
            onDone();
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

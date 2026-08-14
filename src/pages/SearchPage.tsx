import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import SearchBar from "@/components/search/SearchBar";
import { useSearchHotkey } from "@/components/search/useSearchHotkey";
import { ResearchAnswerWithEvidence } from "@/components/search/ResearchEvidenceCarousel";
import { Skeleton } from "@/components/ui/skeleton";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const STAGES = [
  { key: "planning", label: "Understanding the question" },
  { key: "searching", label: "Searching text, meaning & connections" },
  { key: "synthesizing", label: "Composing a cited answer" },
] as const;

export default function SearchPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // /search?id=… loads a stored search from history (no re-run);
  // /search?q=… starts (or reuses) one, then swaps the URL to ?id=.
  const idParam = searchParams.get("id") as Id<"searches"> | null;
  const projectParam = searchParams.get("project") as Id<"projects"> | null;
  const q = searchParams.get("q")?.trim() ?? "";

  // This page carries the bar in its header, so — like the project home —
  // ⌘K focuses that one rather than opening a modal over it.
  const [searchFocus, setSearchFocus] = useState(0);
  useSearchHotkey(useCallback(() => setSearchFocus((n) => n + 1), []));

  const start = useMutation(api.search.start);
  // Tagged with the query it was started for, so a run belonging to a previous
  // q is discarded during render instead of being cleared by a setState in the
  // effect below.
  const [started, setStarted] = useState<{ q: string; id: Id<"searches"> } | null>(null);
  // Guard StrictMode double-effects and q changes: one run per query value
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    if (idParam || !q || !projectParam || startedFor.current === q) return;
    startedFor.current = q;
    void start({ query: q, projectId: projectParam }).then((id) => {
      setStarted({ q, id });
      navigate(`/search?id=${id}`, { replace: true });
    });
  }, [idParam, q, projectParam, start, navigate]);

  const startedId = started && started.q === q ? started.id : null;
  const searchId = idParam ?? startedId;
  const search = useQuery(api.search.get, searchId ? { id: searchId } : "skip");
  const queryText = search?.query ?? q;
  // Project context: from the loaded search row, else the URL
  const projectId = search?.projectId ?? projectParam ?? null;

  async function rerun() {
    if (!queryText || !projectId) return;
    startedFor.current = queryText;
    const id = await start({ query: queryText, projectId, force: true });
    setStarted({ q: queryText, id });
    navigate(`/search?id=${id}`, { replace: true });
  }

  const stageIndex = search
    ? STAGES.findIndex((s) => s.key === search.status)
    : 0;
  const running =
    search && search.status !== "completed" && search.status !== "failed";

  return (
    <div className="flex flex-col">
      <header className="border-b px-6 py-4 flex items-center gap-4">
        <Link
          to={projectId ? `/p/${projectId}` : "/"}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Back to project"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          {projectId && (
            <SearchBar projectId={projectId} focusSignal={searchFocus} />
          )}
        </div>
      </header>

      <div className="flex-1">
        <div className="max-w-6xl mx-auto p-6">
          {!q && !idParam ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              Type a question above to search the corpus.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-4">
                <h1 className="text-lg font-semibold flex items-center gap-2 min-w-0">
                  <Sparkles className="h-4 w-4 text-primary shrink-0" />
                  <span className="truncate">{queryText}</span>
                </h1>
                {search?.status === "completed" && (
                  <button
                    onClick={() => void rerun()}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border rounded-md px-2 py-1 transition-colors shrink-0"
                    title="Run this search again with fresh results"
                  >
                    <RefreshCw className="h-3 w-3" /> Re-run
                  </button>
                )}
              </div>

              {/* Stage progress */}
              {(running || search === undefined || !searchId) && (
                <ol className="mb-6 space-y-2">
                  {STAGES.map((stage, i) => {
                    const done = search ? stageIndex > i : false;
                    const current = search ? stageIndex === i : i === 0;
                    return (
                      <li
                        key={stage.key}
                        className="flex items-center gap-2 text-sm"
                      >
                        {done ? (
                          <Check className="h-4 w-4 text-emerald-500" />
                        ) : current ? (
                          <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        ) : (
                          <span className="h-4 w-4 rounded-full border inline-block" />
                        )}
                        <span
                          className={
                            done || current
                              ? "text-foreground"
                              : "text-muted-foreground"
                          }
                        >
                          {stage.label}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}

              {search?.status === "failed" && (
                <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 text-sm rounded-lg p-4 mb-6">
                  <CircleAlert className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Search failed</p>
                    <p className="text-muted-foreground">
                      {search.errorMessage ?? "Unknown error"}
                    </p>
                  </div>
                </div>
              )}

              {/* Entities the planner resolved */}
              {search?.matchedEntities && search.matchedEntities.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {search.matchedEntities.map((e) => (
                    <Link
                      key={e.entityId}
                      to={`/entity/${toSlug(e.name)}${projectId ? `?project=${projectId}` : ""}`}
                      className="text-xs border rounded-full px-2.5 py-1 hover:bg-accent transition-colors"
                    >
                      {e.name}
                      <span className="text-muted-foreground"> · {e.type}</span>
                    </Link>
                  ))}
                </div>
              )}

              {/* Answer */}
              {search?.answer ? (
                <ResearchAnswerWithEvidence
                  answer={search.answer}
                  results={search.results ?? []}
                />
              ) : search?.status === "synthesizing" ? (
                <div className="max-w-3xl space-y-2 mb-8">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : null}

              {search?.status === "completed" &&
                (search.results?.length ?? 0) === 0 && (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Nothing in the corpus matched this query.
                  </p>
                )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import type { Route } from "./+types/HomePage";
import {
  ArrowLeft,
  Plus,
  RotateCw,
  Settings,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { LibraryRow } from "@/components/documents/LibraryRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SplitPane } from "@/components/ui/SplitPane";
import {
  MergeSuggestions,
  type MergeSuggestion,
} from "@/components/entities/MergeSuggestions";
import SearchBar from "@/components/search/SearchBar";
import { useSearchHotkey } from "@/components/search/useSearchHotkey";
import { ListGroup } from "@/components/views/ListGroup";
import { PropertyChips } from "@/components/views/PropertyChips";
import { ViewBar } from "@/components/views/ViewBar";
import { applyView, type ViewGroup } from "@/lib/views/applyView";
import {
  DOCUMENT_PROPERTIES,
  type LibraryDoc,
} from "@/lib/views/documentProperties";
import {
  ENTITY_PROPERTIES,
  type EntityRow as EntityRowType,
} from "@/lib/views/entityProperties";
import {
  DEFAULT_SPLIT_RATIO,
  useProjectViews,
} from "@/lib/views/useProjectViews";
import { useUploads } from "@/hooks/uploadContext";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { entitySlug } from "@/lib/entitySlug";
import { useConfirm } from "@/components/ui/use-confirm";
import { counted } from "@/lib/plural";

/**
 * The bar that replaces the Library's view controls while rows are checked:
 * what you can do to a selection, and nothing else.
 */
function SelectionToolbar({
  selected,
  rows,
  projectId,
  onClear,
}: {
  selected: Id<"documents">[];
  /** The library's rows, for naming the cards a re-analysis puts up. */
  rows: LibraryDoc[];
  projectId: Id<"projects">;
  onClear: () => void;
}) {
  const addKinds = useMutation(api.documents.addKinds);
  const remove = useMutation(api.documents.remove);
  const reanalyze = useMutation(api.processing.runAnalyze);
  const { trackAnalyze } = useUploads();
  const allKinds = useQuery(api.kinds.list, { projectId });

  const [tagOpen, setTagOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  // Each document is its own mutation: `remove` cascades through pages,
  // blocks, extractions, and stored files, so batching a selection into one
  // transaction would risk blowing the write limits on a large pick.
  async function run(action: (id: Id<"documents">) => Promise<unknown>) {
    setBusy(true);
    try {
      for (const id of selected) await action(id);
      onClear();
    } finally {
      setBusy(false);
    }
  }

  async function applyTag(kind: string) {
    const name = kind.trim().toLowerCase();
    if (!name) return;
    setTagOpen(false);
    setNewTag("");
    await run((id) => addKinds({ id, kinds: [name] }));
  }

  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 text-xs text-muted-foreground">
        {selected.length} selected
      </span>

      <Popover open={tagOpen} onOpenChange={setTagOpen}>
        <PopoverTrigger
          disabled={busy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Tag className="size-3.5" />
          Tag
        </PopoverTrigger>
        <PopoverContent className="w-56 rounded-md border bg-popover p-2 text-popover-foreground shadow-md outline-none">
              <div className="flex flex-col gap-2">
                <div className="flex gap-1">
                  <Input
                    autoFocus
                    value={newTag}
                    placeholder="Add a type…"
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void applyTag(newTag);
                      }
                    }}
                    className="h-7 text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2"
                    disabled={!newTag.trim()}
                    onClick={() => void applyTag(newTag)}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                {(allKinds ?? []).length > 0 && (
                  <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                    {(allKinds ?? []).map((kind) => (
                      <button
                        key={kind.name}
                        type="button"
                        onClick={() => void applyTag(kind.name)}
                        className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                      >
                        {kind.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
        </PopoverContent>
      </Popover>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        disabled={busy}
        onClick={async () => {
          const ok = await confirm({
            title: `Re-analyze ${counted(selected.length, "document")}?`,
            body: "Each one goes back through the Analyze pass, replacing the type, category, dates and place it derived. A title or type you set yourself is kept.",
            confirmLabel: "Re-analyze",
          });
          if (!ok) return;
          // Cards first, then the work: the overlay should answer "did that do
          // anything?" straight away rather than after a round trip each.
          const byId = new Map(rows.map((row) => [row._id, row]));
          trackAnalyze(
            projectId,
            selected.map((id) => {
              const row = byId.get(id);
              return { id, name: row?.displayName || row?.name || "Document" };
            })
          );
          void run((id) => reanalyze({ documentId: id }));
        }}
      >
        <RotateCw className="size-3.5" />
        Re-analyze
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
        disabled={busy}
        onClick={async () => {
          const ok = await confirm({
            title: `Delete ${counted(selected.length, "document")}?`,
            body: "This also removes their pages, extractions, and files. It cannot be undone.",
            confirmLabel: "Delete",
            tone: "destructive",
          });
          if (!ok) return;
          void run((id) => remove({ id }));
        }}
      >
        <Trash2 className="size-3.5" />
        Delete
      </Button>

      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        title="Clear selection"
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function EntityListRow({
  entity,
  projectId,
  visibleProperties,
}: {
  entity: Doc<"entities">;
  projectId: Id<"projects">;
  visibleProperties: string[];
}) {
  const setStarred = useMutation(api.entities.setStarred);
  const starred = entity.starred === true;

  return (
    <div className="relative flex items-center gap-1 rounded py-1 pr-1 -mx-1 transition-colors hover:bg-accent/50">
      <button
        type="button"
        aria-label={`${starred ? "Unstar" : "Star"} ${entity.name}`}
        title={starred ? "Unstar entity" : "Star entity"}
        onClick={() => void setStarred({ id: entity._id, starred: !starred })}
        className={cn(
          "relative z-10 grid size-5 shrink-0 place-items-center rounded transition-colors",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
          starred
            ? "text-amber-500"
            : "text-muted-foreground/45 hover:text-amber-500"
        )}
      >
        <Star className="size-3.5" fill={starred ? "currentColor" : "none"} />
      </button>
      <Link
        to={`/entity/${entitySlug(entity.name)}?project=${projectId}`}
        className="min-w-0 flex-1 truncate text-left text-sm after:absolute after:inset-0 after:content-['']"
      >
        {entity.name}
      </Link>
      <PropertyChips
        row={entity}
        defs={ENTITY_PROPERTIES}
        visible={visibleProperties}
        className="relative z-10 ml-2 shrink-0"
      />
    </div>
  );
}

/**
 * One entity group, owning its own collapse state so it can keep showing
 * starred entities after you close it — the curation stays visible.
 */
function EntityGroup({
  group,
  suggestions,
  projectId,
  visibleProperties,
  forceOpen,
  grouped,
}: {
  group: ViewGroup<EntityRowType>;
  suggestions: MergeSuggestion[];
  projectId: Id<"projects">;
  visibleProperties: string[];
  forceOpen: boolean;
  grouped: boolean;
}) {
  const [open, setOpen] = useState(false);
  const starred = group.rows.filter((entity) => entity.starred === true);

  const rows = (
    <>
      <MergeSuggestions suggestions={suggestions} />
      {group.rows.map((entity) => (
        <EntityListRow
          key={entity._id}
          entity={entity}
          projectId={projectId}
          visibleProperties={visibleProperties}
        />
      ))}
    </>
  );

  // Ungrouped: no header to collapse, so the rows stand on their own.
  if (!grouped) return <div className="flex flex-col">{rows}</div>;

  return (
    <ListGroup
      label={group.label}
      count={group.rows.length}
      forceOpen={forceOpen}
      onToggle={setOpen}
      footer={
        !forceOpen && !open && starred.length > 0 ? (
          <div className="flex flex-col pl-4">
            {starred.map((entity) => (
              <EntityListRow
                key={entity._id}
                entity={entity}
                projectId={projectId}
                visibleProperties={visibleProperties}
              />
            ))}
          </div>
        ) : null
      }
    >
      {rows}
    </ListGroup>
  );
}

function ProjectHomeSkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-12">
      <Skeleton className="mx-auto h-8 w-64" />
      <Skeleton className="mx-auto h-10 w-full" />
    </div>
  );
}

function ProjectNotFound() {
  return (
    <div className="p-12 text-center text-sm text-muted-foreground">
      No project at this address.{" "}
      <Link to="/" className="underline hover:text-foreground">
        Pick one
      </Link>
      .
    </div>
  );
}

/**
 * `/p/:slug` names a project the way the user does. Everything below this page
 * is keyed by the project's id, so the row has to be resolved before any of it
 * can run — hence the split: this half resolves, the other half renders.
 */
export default function HomePage({ params }: Route.ComponentProps) {
  const project = useQuery(api.projects.getBySlug, { slug: params.slug });

  if (project === undefined) return <ProjectHomeSkeleton />;
  if (project === null) return <ProjectNotFound />;
  // Keyed on the id so moving between projects remounts, rather than carrying
  // the previous project's selection and view state into the next one.
  return <ProjectHome key={project._id} project={project} />;
}

function ProjectHome({ project }: { project: Doc<"projects"> }) {
  const projectId = project._id;

  // The search bar is already on this page, so ⌘K walks the user to it —
  // focused and briefly ringed — instead of stacking a modal copy over it.
  const [searchFocus, setSearchFocus] = useState(0);
  useSearchHotkey(useCallback(() => setSearchFocus((n) => n + 1), []));

  const allDocuments = useQuery(api.documents.list, { projectId });
  // A file being ingested lives in the upload card, not here — it joins the
  // library only once the pipeline has finished with it.
  const { heldDocumentIds } = useUploads();
  const documents = useMemo(
    () =>
      heldDocumentIds.size === 0
        ? allDocuments
        : allDocuments?.filter((doc) => !heldDocumentIds.has(doc._id)),
    [allDocuments, heldDocumentIds]
  );
  const entities = useQuery(api.entities.listAll, { projectId });
  const mergeSuggestions = useQuery(api.mergeSuggestions.listPending, {
    projectId,
  });

  const views = useProjectViews(projectId);

  // Search text is deliberately not persisted: it's a momentary "where is
  // that one" rather than a way of looking at the list.
  const [libraryQuery, setLibraryQuery] = useState("");
  const [entityQuery, setEntityQuery] = useState("");

  const [selectedRaw, setSelected] = useState<Id<"documents">[]>([]);
  const selectionAnchor = useRef<number | null>(null);
  const libraryRef = useRef<HTMLDivElement>(null);

  const clearSelection = useCallback(() => {
    selectionAnchor.current = null;
    setSelected([]);
  }, []);

  // True once the hero title has scrolled up under the header bar, which is
  // when the bar stops being an empty corner and becomes a real header.
  const heroSentinelRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const sentinel = heroSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { rootMargin: "-48px 0px 0px 0px", threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const libraryRows = useMemo<LibraryDoc[]>(() => documents ?? [], [documents]);
  const entityRows = useMemo<EntityRowType[]>(() => entities ?? [], [entities]);

  const libraryResult = useMemo(
    () => applyView(libraryRows, DOCUMENT_PROPERTIES, views.library, libraryQuery),
    [libraryRows, views.library, libraryQuery]
  );
  const entityResult = useMemo(
    () => applyView(entityRows, ENTITY_PROPERTIES, views.entities, entityQuery),
    [entityRows, views.entities, entityQuery]
  );

  // Drop anything that left the list — archived, deleted, or filtered out — so
  // the toolbar never counts rows the user can no longer see. Derived rather
  // than pruned in an effect: the stale ids never reach a render this way.
  const selected = useMemo(() => {
    if (selectedRaw.length === 0) return selectedRaw;
    const visible = new Set(libraryResult.flat.map((doc) => doc._id));
    if (selectedRaw.every((id) => visible.has(id))) return selectedRaw;
    return selectedRaw.filter((id) => visible.has(id));
  }, [selectedRaw, libraryResult]);

  // A click anywhere outside the Library column drops the selection — the
  // same way a file list does. The Tag popover is portalled to the body, so
  // it's outside the column in the DOM and has to be excused explicitly.
  useEffect(() => {
    if (selected.length === 0) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (libraryRef.current?.contains(target)) return;
      if (target.closest("[role='dialog']")) return;
      clearSelection();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [selected.length, clearSelection]);

  // Ranges run over the flattened display order, so a shift-click still means
  // "everything between these two rows" when the list is grouped.
  const extendSelection = useCallback(
    (index: number) => {
      const anchor = selectionAnchor.current;
      if (anchor === null) return false;
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      const range = libraryResult.flat.slice(from, to + 1).map((doc) => doc._id);
      setSelected((current) => [...new Set([...current, ...range])]);
      return true;
    },
    [libraryResult]
  );

  const toggleSelection = useCallback(
    (checked: boolean, index: number, id: Id<"documents">) => {
      selectionAnchor.current = index;
      setSelected((current) =>
        checked
          ? [...new Set([...current, id])]
          : current.filter((other) => other !== id)
      );
    },
    []
  );

  // Put each merge prompt beside the group its entity is in. Keyed on the
  // surviving target, falling back to the source for stale query frames.
  const suggestionsByGroup = useMemo(() => {
    const groupOf = new Map<string, string>();
    for (const group of entityResult.groups) {
      for (const entity of group.rows) {
        if (!groupOf.has(entity._id)) groupOf.set(entity._id, group.key);
      }
    }
    const byGroup = new Map<string, MergeSuggestion[]>();
    for (const suggestion of mergeSuggestions ?? []) {
      const key =
        groupOf.get(suggestion.target._id) ?? groupOf.get(suggestion.source._id);
      if (key === undefined) continue;
      byGroup.set(key, [...(byGroup.get(key) ?? []), suggestion]);
    }
    return byGroup;
  }, [entityResult, mergeSuggestions]);

  const libraryGrouped = !!views.library.groupBy;
  const entitiesGrouped = !!views.entities.groupBy;
  // Filtering already narrowed the list to what was asked for; collapsing on
  // top of that would hide the answer.
  const libraryNarrowed =
    libraryQuery.trim() !== "" || views.library.filters.length > 0;
  const entitiesNarrowed =
    entityQuery.trim() !== "" || views.entities.filters.length > 0;

  // Row position, by identity. This was `flat.indexOf(doc)` *inside* the map —
  // a linear scan per row, so O(n²) per render, re-run on every keystroke in
  // the search box because the memo above depends on the query string.
  const libraryIndexByDoc = useMemo(() => {
    const map = new Map<LibraryDoc, number>();
    libraryResult.flat.forEach((doc, i) => map.set(doc, i));
    return map;
  }, [libraryResult.flat]);

  function renderLibraryRows(group: ViewGroup<LibraryDoc>) {
    return group.rows.map((doc) => {
      const index = libraryIndexByDoc.get(doc) ?? 0;
      return (
        <LibraryRow
          key={`${group.key}:${doc._id}`}
          doc={doc}
          index={index}
          checked={selected.includes(doc._id)}
          anySelected={selected.length > 0}
          visibleProperties={views.library.visibleProperties}
          onCheckedChange={(checked, at) => toggleSelection(checked, at, doc._id)}
          onShiftClick={extendSelection}
        />
      );
    });
  }

  return (
    <div className="relative flex flex-col">
      {/* Back to all projects — a quiet corner affordance at rest. Once the big
          project name has scrolled away it earns its bar: the name joins it and
          the strip picks up a background so the lists slide underneath. */}
      <div
        className={cn(
          "sticky top-0 z-30 flex h-12 items-center gap-2 px-4 transition-colors",
          scrolled && "bg-background"
        )}
      >
        <Link
          to="/"
          title="All projects"
          aria-label="All projects"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <span
          aria-hidden={!scrolled}
          className={cn(
            "min-w-0 truncate text-lg font-semibold transition-opacity",
            scrolled ? "opacity-100" : "opacity-0"
          )}
        >
          {project?.name ?? ""}
        </span>
        <Link
          to={`/p/${project.slug}/settings`}
          title="Project settings"
          aria-label="Project settings"
          className="ml-auto grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <Settings className="size-4" />
        </Link>
      </div>

      <div className="flex-1">
        <div className="px-6 pb-6">
          <div className="mx-auto mb-6 mt-4 max-w-2xl text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              {project?.name ?? "…"}
            </h1>
            <p className="mt-2 text-base text-muted-foreground">
              {project?.description?.trim() ||
                "Upload anything, extract entities, uncover connections."}
            </p>
          </div>

          <div ref={heroSentinelRef} aria-hidden className="h-px" />

          <div className="mb-8">
            <SearchBar projectId={projectId} focusSignal={searchFocus} />
          </div>

          <SplitPane
            // Height of both panes' sticky header: the 1.75rem control row,
            // its pb-2, and the border-b itself. The divider rule starts
            // below that line rather than beside the headings.
            className="[--split-divider-inset:calc(1.75rem+0.5rem+1px)]"
            ratio={views.splitRatio}
            defaultRatio={DEFAULT_SPLIT_RATIO}
            onCommit={views.setSplitRatio}
            left={
              <div ref={libraryRef}>
                <div className="sticky top-12 z-20 mb-2 bg-background">
                  <div className="flex items-center justify-between gap-3 border-b pb-2">
                    <h2 className="shrink-0 text-lg font-semibold">Library</h2>
                    {selected.length > 0 ? (
                      <SelectionToolbar
                        selected={selected}
                        rows={libraryRows}
                        projectId={projectId}
                        onClear={clearSelection}
                      />
                    ) : (
                      <div className="flex min-w-0 items-center gap-1">
                        <ViewBar
                          defs={DOCUMENT_PROPERTIES}
                          config={views.library}
                          onChange={views.setLibrary}
                          rows={libraryRows}
                          query={libraryQuery}
                          onQueryChange={setLibraryQuery}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {documents === undefined ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-full" />
                  </div>
                ) : documents.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Your library is empty. Drag files onto this window, paste
                    them, or use Add files to get started.
                  </p>
                ) : libraryResult.total === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Nothing in your library matches this view.
                  </p>
                ) : (
                  <div className="flex flex-col">
                    {libraryResult.groups.map((group) =>
                      libraryGrouped ? (
                        <ListGroup
                          key={group.key}
                          label={group.label}
                          count={group.rows.length}
                          forceOpen={libraryNarrowed}
                          defaultOpen
                        >
                          {renderLibraryRows(group)}
                        </ListGroup>
                      ) : (
                        <div key={group.key} className="flex flex-col">
                          {renderLibraryRows(group)}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            }
            right={
              <div>
                <div className="sticky top-12 z-20 mb-2 bg-background">
                  <div className="flex items-center justify-between gap-3 border-b pb-2">
                    <h2 className="shrink-0 text-lg font-semibold">Entities</h2>
                    <ViewBar
                      defs={ENTITY_PROPERTIES}
                      config={views.entities}
                      onChange={views.setEntities}
                      rows={entityRows}
                      query={entityQuery}
                      onQueryChange={setEntityQuery}
                    />
                  </div>
                </div>

                {entities === undefined ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-full" />
                  </div>
                ) : entities.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No entities found yet. Open a document and run an extraction.
                  </p>
                ) : entityResult.total === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No entities match this view.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {entityResult.groups.map((group) => (
                      <EntityGroup
                        key={group.key}
                        group={group}
                        suggestions={suggestionsByGroup.get(group.key) ?? []}
                        projectId={projectId}
                        visibleProperties={views.entities.visibleProperties}
                        forceOpen={entitiesNarrowed}
                        grouped={entitiesGrouped}
                      />
                    ))}
                  </div>
                )}
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

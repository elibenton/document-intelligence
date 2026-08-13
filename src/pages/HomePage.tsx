import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import {
  Archive,
  ArrowLeft,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Filter,
  Plus,
  Search,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { DropZone } from "@/components/documents/DropZone";
import { ReviewDialog } from "@/components/documents/ReviewDialog";
import { DocStatusIndicator } from "@/components/documents/DocStatusIndicator";
import { DocumentIdentityMenu } from "@/components/documents/DocumentIdentityMenu";
import { DocTypeIcon } from "@/components/documents/DocTypeIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MergeSuggestions,
  type MergeSuggestion,
} from "@/components/entities/MergeSuggestions";
import SearchBar from "@/components/search/SearchBar";
import { documentTitles } from "@/lib/documentTitle";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const typeLabels: Record<string, string> = {
  people: "People",
  person: "People",
  organization: "Organizations",
  places: "Places",
  place: "Places",
  dates: "Dates",
  other: "Other",
};

const sourceTypeLabels: Record<string, string> = {
  pdf: "PDF",
  docx: "Word",
  csv: "CSV",
  image: "Image",
  audio: "Audio",
  video: "Video",
  webScrape: "Web clip",
  other: "Other",
};

function entityTypeKey(type: string): string {
  if (type === "people") return "person";
  if (type === "places") return "place";
  return type;
}

function sourceType(doc: Doc<"documents">): string {
  if (doc.mediaType) return doc.mediaType;
  if (doc.mimeType === "application/pdf") return "pdf";
  if (doc.mimeType.includes("wordprocessingml")) return "docx";
  if (doc.mimeType.includes("csv")) return "csv";
  if (doc.mimeType.startsWith("image/")) return "image";
  if (doc.mimeType.startsWith("audio/")) return "audio";
  if (doc.mimeType.startsWith("video/")) return "video";
  return "other";
}

type ToolbarOption = { value: string; label: string };

function ToolbarSelect({
  icon: Icon,
  label,
  value,
  options,
  onChange,
  active = false,
}: {
  icon: typeof Filter;
  label: string;
  value: string;
  options: ToolbarOption[];
  onChange: (value: string) => void;
  active?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? label;

  useEffect(() => {
    if (expanded) selectRef.current?.focus();
  }, [expanded]);

  return (
    <div
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
        }
      }}
      className={cn(
        "relative inline-flex h-7 min-w-0 items-center rounded-md text-xs transition-colors",
        active && "bg-accent text-foreground"
      )}
    >
      <button
        type="button"
        aria-label={`${label}: ${selectedLabel}`}
        aria-expanded={expanded}
        title={label}
        onClick={() => setExpanded((current) => !current)}
        className="relative grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Icon className="h-3.5 w-3.5" />
        {active && (
          <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-blue-500 ring-1 ring-background" />
        )}
      </button>
      {expanded && (
        <label className="absolute right-0 top-full z-30 mt-1 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          <span className="sr-only">{label}</span>
          <select
            ref={selectRef}
            aria-label={label}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setExpanded(false);
            }}
            className="h-7 w-full cursor-pointer appearance-none rounded-md bg-transparent py-0 pl-2 pr-6 text-xs outline-none hover:bg-accent"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        </label>
      )}
    </div>
  );
}

function ToolbarSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  return (
    <div
      className={cn(
        "flex h-7 items-center rounded-md transition-colors",
        value && "bg-accent"
      )}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
        }
      }}
    >
      <button
        type="button"
        aria-label="Search this view"
        aria-expanded={expanded}
        title="Search"
        onClick={() => setExpanded((current) => !current)}
        className="relative grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="h-3.5 w-3.5" />
        {value && (
          <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-blue-500 ring-1 ring-background" />
        )}
      </button>
      {expanded && (
        <input
          ref={inputRef}
          type="search"
          aria-label="Search this view input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search"
          className="absolute right-0 top-full z-30 mt-1 h-9 w-44 rounded-lg border bg-popover px-3 text-xs text-popover-foreground shadow-md outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
      )}
    </div>
  );
}

function ViewToolbar({
  query,
  onQueryChange,
  children,
  onClear,
  hasActiveView,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  children: React.ReactNode;
  onClear: () => void;
  hasActiveView: boolean;
}) {
  return (
    <div className="flex items-center gap-1 bg-background">
      {children}
      <ToolbarSearch value={query} onChange={onQueryChange} />
      {hasActiveView && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear filters and sort"
          title="Clear filters and sort"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * The bar that replaces the Sources filter/sort toolbar while rows are
 * checked: what you can do to a selection, and nothing else.
 */
function SelectionToolbar({
  selected,
  onClear,
}: {
  selected: Id<"documents">[];
  onClear: () => void;
}) {
  const setArchived = useMutation(api.documents.setArchived);
  const addKinds = useMutation(api.documents.addKinds);
  const remove = useMutation(api.documents.remove);
  const allKinds = useQuery(api.kinds.list);

  const [tagOpen, setTagOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState(false);

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

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        disabled={busy}
        onClick={() =>
          void run((id) => setArchived({ id, archived: true }))
        }
      >
        <Archive className="h-3.5 w-3.5" />
        Archive
      </Button>

      <Popover.Root open={tagOpen} onOpenChange={setTagOpen}>
        <Popover.Trigger
          disabled={busy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Tag className="h-3.5 w-3.5" />
          Tag
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            side="bottom"
            align="end"
            sideOffset={6}
            className="z-50"
          >
            <Popover.Popup className="w-56 rounded-md border bg-popover p-2 text-popover-foreground shadow-md outline-none">
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
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {(allKinds ?? []).length > 0 && (
                  <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                    {(allKinds ?? []).map((kind) => (
                      <button
                        key={kind.name}
                        type="button"
                        onClick={() => void applyTag(kind.name)}
                        className="rounded-4xl border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                      >
                        {kind.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
        disabled={busy}
        onClick={() => {
          const plural = selected.length === 1 ? "source" : "sources";
          if (
            !window.confirm(
              `Delete ${selected.length} ${plural}? This also removes their pages, extractions, and files.`
            )
          ) {
            return;
          }
          void run((id) => remove({ id }));
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </Button>

      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        title="Clear selection"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function EntityRow({
  entity,
  projectId,
}: {
  entity: Doc<"entities">;
  projectId: Id<"projects">;
}) {
  const setStarred = useMutation(api.entities.setStarred);
  const starred = entity.starred === true;

  return (
    <div className="relative flex items-center gap-1 rounded py-1 pr-1 -mx-1 hover:bg-accent/50 transition-colors">
      <button
        type="button"
        aria-label={`${starred ? "Unstar" : "Star"} ${entity.name}`}
        title={starred ? "Unstar entity" : "Star entity"}
        onClick={() => void setStarred({ id: entity._id, starred: !starred })}
        className={cn(
          "relative z-10 grid h-5 w-5 shrink-0 place-items-center rounded transition-colors",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          starred
            ? "text-amber-500"
            : "text-muted-foreground/45 hover:text-amber-500"
        )}
      >
        <Star className="h-3.5 w-3.5" fill={starred ? "currentColor" : "none"} />
      </button>
      <Link
        to={`/entity/${toSlug(entity.name)}?project=${projectId}`}
        className="min-w-0 flex-1 truncate text-left text-sm after:absolute after:inset-0 after:content-['']"
      >
        {entity.name}
      </Link>
      <span className="relative z-10 ml-2 shrink-0 text-xs text-muted-foreground">
        {entity.mentionCount} mention{entity.mentionCount !== 1 && "s"}
      </span>
    </div>
  );
}

function EntityTypeGroup({
  type,
  entities,
  suggestions,
  projectId,
  forceOpen,
}: {
  type: string;
  entities: Doc<"entities">[];
  suggestions: MergeSuggestion[];
  projectId: Id<"projects">;
  forceOpen: boolean;
}) {
  const [open, setOpen] = useState(false);
  const starredEntities = entities.filter((entity) => entity.starred === true);

  return (
    <div>
      <details
        className="group"
        open={forceOpen || undefined}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex items-center justify-between cursor-pointer py-1.5 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors list-none [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1 text-sm font-medium">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
            {typeLabels[type] ?? type}
          </span>
          <span className="text-xs text-muted-foreground">{entities.length}</span>
        </summary>
        <div className="flex flex-col pl-4">
          <MergeSuggestions suggestions={suggestions} />
          {entities.map((entity) => (
            <EntityRow
              key={entity._id}
              entity={entity}
              projectId={projectId}
            />
          ))}
        </div>
      </details>

      {!forceOpen && !open && starredEntities.length > 0 && (
        <div className="flex flex-col pl-4">
          {starredEntities.map((entity) => (
            <EntityRow
              key={entity._id}
              entity={entity}
              projectId={projectId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function HomePage() {
  const { projectId } = useParams<{ projectId: string }>() as {
    projectId: Id<"projects">;
  };

  const project = useQuery(api.projects.get, { id: projectId });
  const documents = useQuery(api.documents.list, { projectId });
  const entities = useQuery(api.entities.listAll, { projectId });
  const mergeSuggestions = useQuery(api.mergeSuggestions.listPending, {
    projectId,
  });

  // Which sources still owe a review decision. Clicking one of them in the
  // list opens its review instead of the viewer — the queue lives in the
  // Sources list now rather than in a panel of its own.
  const reviewQueue = useQuery(api.documents.reviewQueue, { projectId });
  const needsReview = useMemo(
    () => new Set((reviewQueue ?? []).map((doc) => doc._id)),
    [reviewQueue]
  );
  const [reviewingId, setReviewingId] = useState<Id<"documents"> | null>(null);
  const reviewing =
    (reviewQueue ?? []).find((doc) => doc._id === reviewingId) ?? null;

  const [selectedRaw, setSelected] = useState<Id<"documents">[]>([]);
  // The last row checked on its own — the anchor a shift-click extends from.
  const selectionAnchor = useRef<number | null>(null);
  const sourcesRef = useRef<HTMLDivElement>(null);

  function clearSelection() {
    selectionAnchor.current = null;
    setSelected([]);
  }

  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceTypeFilter, setSourceTypeFilter] = useState("all");
  const [sourceSort, setSourceSort] = useState("newest");
  const [entityQuery, setEntityQuery] = useState("");
  const [entityTypeFilter, setEntityTypeFilter] = useState("all");
  const [entitySort, setEntitySort] = useState("mentions-desc");

  const sourceTypeOptions = useMemo(() => {
    const available = new Set((documents ?? []).map(sourceType));
    return [
      { value: "all", label: "All types" },
      ...Object.entries(sourceTypeLabels)
        .filter(([value]) => available.has(value))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [documents]);

  const visibleDocuments = useMemo(() => {
    const query = sourceQuery.trim().toLocaleLowerCase();
    const filtered = (documents ?? []).filter((doc) => {
      const { primary, original } = documentTitles(doc);
      const matchesQuery =
        !query ||
        primary.toLocaleLowerCase().includes(query) ||
        original?.toLocaleLowerCase().includes(query) ||
        doc.sourceUrl?.toLocaleLowerCase().includes(query);
      return (
        matchesQuery &&
        (sourceTypeFilter === "all" || sourceType(doc) === sourceTypeFilter)
      );
    });

    return filtered.sort((a, b) => {
      const aTitle = documentTitles(a).primary;
      const bTitle = documentTitles(b).primary;
      if (sourceSort === "oldest") return a.uploadedAt - b.uploadedAt;
      if (sourceSort === "name-asc") return aTitle.localeCompare(bTitle);
      if (sourceSort === "name-desc") return bTitle.localeCompare(aTitle);
      return b.uploadedAt - a.uploadedAt;
    });
  }, [documents, sourceQuery, sourceSort, sourceTypeFilter]);

  // Drop anything that left the list — archived, deleted, or filtered out — so
  // the toolbar never counts rows the user can no longer see. Derived rather
  // than pruned in an effect: the stale ids never reach a render this way.
  const selected = useMemo(() => {
    if (selectedRaw.length === 0) return selectedRaw;
    const visible = new Set(visibleDocuments.map((doc) => doc._id));
    if (selectedRaw.every((id) => visible.has(id))) return selectedRaw;
    return selectedRaw.filter((id) => visible.has(id));
  }, [selectedRaw, visibleDocuments]);

  // A click anywhere outside the Sources column drops the selection — the
  // same way a file list does. The Tag popover is portalled to the body, so
  // it's outside the column in the DOM and has to be excused explicitly.
  useEffect(() => {
    if (selected.length === 0) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (sourcesRef.current?.contains(target)) return;
      if (target.closest("[role='dialog']")) return;
      clearSelection();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [selected.length]);

  const entityTypeOptions = useMemo(() => {
    const available = new Map<string, string>();
    for (const entity of entities ?? []) {
      const key = entityTypeKey(entity.type);
      available.set(key, typeLabels[key] ?? key);
    }
    return [
      { value: "all", label: "All types" },
      ...[...available.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [entities]);

  const visibleEntities = useMemo(() => {
    const query = entityQuery.trim().toLocaleLowerCase();
    const filtered = (entities ?? []).filter(
      (entity) =>
        (!query || entity.name.toLocaleLowerCase().includes(query)) &&
        (entityTypeFilter === "all" ||
          entityTypeKey(entity.type) === entityTypeFilter)
    );

    return filtered.sort((a, b) => {
      if (entitySort === "mentions-asc") return a.mentionCount - b.mentionCount;
      if (entitySort === "documents-desc") {
        return b.documentCount - a.documentCount;
      }
      if (entitySort === "name-asc") return a.name.localeCompare(b.name);
      if (entitySort === "name-desc") return b.name.localeCompare(a.name);
      return b.mentionCount - a.mentionCount;
    });
  }, [entities, entityQuery, entitySort, entityTypeFilter]);

  // Group entities by type
  const entityGroups = new Map<string, NonNullable<typeof entities>>();
  if (visibleEntities) {
    for (const entity of visibleEntities) {
      const group = entityGroups.get(entity.type) ?? [];
      group.push(entity);
      entityGroups.set(entity.type, group);
    }
  }

  const sortedTypes = [...entityGroups.keys()].sort((a, b) => {
    if (a === "people" || a === "person") return -1;
    if (b === "people" || b === "person") return 1;
    return a.localeCompare(b);
  });

  // Put each review prompt beside the list it affects. Prefer the surviving
  // target's type; fall back to the source for stale/incomplete query frames.
  const entityTypeById = new Map<string, string>();
  for (const [type, group] of entityGroups) {
    for (const entity of group) entityTypeById.set(entity._id, type);
  }
  const mergeSuggestionsByType = new Map<string, MergeSuggestion[]>();
  for (const suggestion of mergeSuggestions ?? []) {
    const type =
      entityTypeById.get(suggestion.target._id) ??
      entityTypeById.get(suggestion.source._id);
    if (!type) continue;
    const group = mergeSuggestionsByType.get(type) ?? [];
    group.push(suggestion);
    mergeSuggestionsByType.set(type, group);
  }

  const hasSourceView =
    sourceQuery !== "" ||
    sourceTypeFilter !== "all" ||
    sourceSort !== "newest";
  const hasEntityView =
    entityQuery !== "" ||
    entityTypeFilter !== "all" ||
    entitySort !== "mentions-desc";
  const forceEntityGroupsOpen =
    entityQuery.trim() !== "" ||
    entityTypeFilter !== "all";

  return (
    <div className="relative flex flex-col">
      {/* Back to all projects — a quiet corner affordance, not a header bar. */}
      <Link
        to="/"
        title="All projects"
        aria-label="All projects"
        className="absolute left-4 top-4 z-30 grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
      </Link>

      <div className="flex-1">
        <div className="p-6">
        {/* The project announces itself above the search box: name big,
            description under it, both centered on the thing you came to do. */}
        <div className="mx-auto mb-6 mt-10 max-w-2xl text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            {project?.name ?? "…"}
          </h1>
          {/* The project's own description, falling back to the generic
              pitch for projects that don't have one yet. */}
          <p className="mt-2 text-base text-muted-foreground">
            {project?.description?.trim() ||
              "Upload anything, extract entities, uncover connections."}
          </p>
        </div>

        {/* Search — full-text + semantic + entity-graph, Interfaze-planned */}
        <div className="mb-8">
          <SearchBar projectId={projectId} />
        </div>

        <div className="mb-8">
          <DropZone projectId={projectId} />
        </div>

        {/* Three-column grid: Sources (spans 2) | Entities */}
        <div className="grid grid-cols-3 gap-6">
          {/* Sources — documents, recordings, and web clips in one list */}
          <div className="col-span-2" ref={sourcesRef}>
            <div className="sticky top-0 z-20 mb-2 bg-background">
              <div className="flex items-center justify-between gap-3 border-b pb-2">
                <h2 className="text-lg font-semibold">Sources</h2>
                {selected.length > 0 ? (
                  <SelectionToolbar
                    selected={selected}
                    onClear={clearSelection}
                  />
                ) : (
                <ViewToolbar
                  query={sourceQuery}
                  onQueryChange={setSourceQuery}
                  hasActiveView={hasSourceView}
                  onClear={() => {
                    setSourceQuery("");
                    setSourceTypeFilter("all");
                    setSourceSort("newest");
                  }}
                >
                  <ToolbarSelect
                    icon={Filter}
                    label="Filter sources by type"
                    value={sourceTypeFilter}
                    onChange={setSourceTypeFilter}
                    active={sourceTypeFilter !== "all"}
                    options={sourceTypeOptions}
                  />
                  <ToolbarSelect
                    icon={ArrowUpDown}
                    label="Sort sources"
                    value={sourceSort}
                    onChange={setSourceSort}
                    active={sourceSort !== "newest"}
                    options={[
                      { value: "newest", label: "Newest first" },
                      { value: "oldest", label: "Oldest first" },
                      { value: "name-asc", label: "Name A–Z" },
                      { value: "name-desc", label: "Name Z–A" },
                    ]}
                  />
                </ViewToolbar>
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
              <p className="text-sm text-muted-foreground py-8 text-center">
                No sources yet. Drop a file above to get started.
              </p>
            ) : visibleDocuments.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No sources match this view.
              </p>
            ) : (
              <div className="flex flex-col">
                {visibleDocuments.map((doc, index) => {
                  const { primary, original } = documentTitles(doc);
                  const checked = selected.includes(doc._id);
                  return (
                  // The row is a link, but the checkbox and identity menu
                  // inside it are controls — so the link is the title with a
                  // stretched hit area (::after) and the controls sit above it
                  // on z-10, rather than buttons nested inside an anchor.
                  <div
                    key={doc._id}
                    className={cn(
                      "group/row relative flex items-center justify-between py-1.5 px-1 -mx-1 rounded transition-colors hover:bg-accent/50",
                      checked && "bg-accent/50"
                    )}
                  >
                    <span className="flex items-start gap-1.5 min-w-0">
                      {/* The media-type icon doubles as the selection
                          checkbox: it swaps when you hover the icon itself,
                          and stays a checkbox for every row once a selection
                          exists. */}
                      <span className="group/check relative z-10 mt-0.5 grid h-5 w-5 shrink-0 place-items-center">
                        <DocTypeIcon
                          mediaType={doc.mediaType}
                          mimeType={doc.mimeType}
                          className={cn(
                            "col-start-1 row-start-1 pointer-events-none transition-opacity",
                            selected.length > 0
                              ? "opacity-0"
                              : "group-hover/check:opacity-0"
                          )}
                        />
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`Select ${primary}`}
                          // Shift-click extends from the last row checked on
                          // its own, the way a file list does. It's handled on
                          // click, not change: only the click event carries
                          // the modifier keys.
                          onClick={(event) => {
                            if (!event.shiftKey) return;
                            const anchor = selectionAnchor.current;
                            if (anchor === null) return;
                            event.preventDefault();
                            const [from, to] =
                              anchor < index ? [anchor, index] : [index, anchor];
                            const range = visibleDocuments
                              .slice(from, to + 1)
                              .map((d) => d._id);
                            setSelected((current) => [
                              ...new Set([...current, ...range]),
                            ]);
                          }}
                          onChange={(event) => {
                            selectionAnchor.current = index;
                            setSelected((current) =>
                              event.target.checked
                                ? [...new Set([...current, doc._id])]
                                : current.filter((id) => id !== doc._id)
                            );
                          }}
                          className={cn(
                            "col-start-1 row-start-1 h-3.5 w-3.5 cursor-pointer accent-primary transition-opacity",
                            selected.length === 0 &&
                              "opacity-0 group-hover/check:opacity-100 focus-visible:opacity-100"
                          )}
                        />
                      </span>
                      <span className="flex flex-col min-w-0">
                        <span className="flex items-center gap-1.5 min-w-0">
                          {/* A source still awaiting a review decision opens
                              its review; everything else opens the viewer. */}
                          {needsReview.has(doc._id) ? (
                            <button
                              type="button"
                              onClick={() => setReviewingId(doc._id)}
                              className="text-sm truncate text-left after:absolute after:inset-0 after:content-['']"
                            >
                              {primary}
                            </button>
                          ) : (
                            <Link
                              to={`/documents/${doc._id}`}
                              className="text-sm truncate after:absolute after:inset-0 after:content-['']"
                            >
                              {primary}
                            </Link>
                          )}
                          {doc.mediaType === "webScrape" && doc.sourceUrl && (
                            <span className="text-xs text-muted-foreground truncate shrink-0">
                              {domainOf(doc.sourceUrl)}
                            </span>
                          )}
                        </span>
                        {/* The upload's own name, kept visible beneath the
                            AI-written title so the file stays recognizable. */}
                        {original && (
                          <span className="text-xs text-muted-foreground truncate">
                            {original}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0 ml-3">
                      {/* Renaming and typing a single document used to live on
                          the icon; the icon is the checkbox now, so the ⋮
                          moves here and appears on row hover. */}
                      <DocumentIdentityMenu
                        document={doc}
                        className="relative z-10 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
                      />
                      <DocStatusIndicator
                        status={doc.status}
                        mediaType={doc.mediaType}
                        mimeType={doc.mimeType}
                        reviewSkippedAt={doc.reviewSkippedAt}
                      />
                      <span className="text-xs text-muted-foreground">
                        {new Date(doc.uploadedAt).toLocaleDateString()}
                      </span>
                    </span>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Entities — collapsed groups by type */}
          <div>
            <div className="sticky top-0 z-20 mb-2 bg-background">
              <div className="flex items-center justify-between gap-3 border-b pb-2">
                <h2 className="text-lg font-semibold">Entities</h2>
                <ViewToolbar
                  query={entityQuery}
                  onQueryChange={setEntityQuery}
                  hasActiveView={hasEntityView}
                  onClear={() => {
                    setEntityQuery("");
                    setEntityTypeFilter("all");
                    setEntitySort("mentions-desc");
                  }}
                >
                  <ToolbarSelect
                    icon={Filter}
                    label="Filter entities by type"
                    value={entityTypeFilter}
                    onChange={setEntityTypeFilter}
                    active={entityTypeFilter !== "all"}
                    options={entityTypeOptions}
                  />
                  <ToolbarSelect
                    icon={ArrowUpDown}
                    label="Sort entities"
                    value={entitySort}
                    onChange={setEntitySort}
                    active={entitySort !== "mentions-desc"}
                    options={[
                      { value: "mentions-desc", label: "Most mentioned" },
                      { value: "mentions-asc", label: "Least mentioned" },
                      { value: "documents-desc", label: "Most sources" },
                      { value: "name-asc", label: "Name A–Z" },
                      { value: "name-desc", label: "Name Z–A" },
                    ]}
                  />
                </ViewToolbar>
              </div>
            </div>
            {entities === undefined ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : entities.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No entities found yet. Open a document and run an extraction.
              </p>
            ) : visibleEntities.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No entities match this view.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {sortedTypes.map((type) => (
                  <EntityTypeGroup
                    key={type}
                    type={type}
                    entities={entityGroups.get(type)!}
                    suggestions={mergeSuggestionsByType.get(type) ?? []}
                    projectId={projectId}
                    forceOpen={forceEntityGroupsOpen}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        </div>
      </div>

      {reviewing && (
        <ReviewDialog
          document={reviewing}
          onClose={() => setReviewingId(null)}
        />
      )}
    </div>
  );
}

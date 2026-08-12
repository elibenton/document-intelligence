import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Filter,
  Search,
  Star,
  X,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { DropZone } from "@/components/documents/DropZone";
import { DocStatusIndicator } from "@/components/documents/DocStatusIndicator";
import { DocumentIdentityMenu } from "@/components/documents/DocumentIdentityMenu";
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
    <div className="flex flex-col">
      <header className="border-b px-6 py-4 flex items-start justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/"
            title="All projects"
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">
              {project?.name ?? "…"}
            </h1>
            {/* The project's own description, falling back to the generic
                pitch for projects that don't have one yet. */}
            <p className="text-sm text-muted-foreground truncate">
              {project?.description?.trim() ||
                "Upload anything, extract entities, uncover connections."}
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1">
        <div className="p-6">
        {/* Search — full-text + semantic + entity-graph, Interfaze-planned */}
        <div className="mb-8 mt-2">
          <SearchBar projectId={projectId} />
        </div>

        {/* Drop zone */}
        <div className="mb-8">
          <DropZone projectId={projectId} />
        </div>

        {/* Three-column grid: Sources (spans 2) | Entities */}
        <div className="grid grid-cols-3 gap-6">
          {/* Sources — documents, recordings, and web clips in one list */}
          <div className="col-span-2">
            <div className="sticky top-0 z-20 mb-2 bg-background">
              <div className="flex items-center justify-between gap-3 border-b pb-2">
                <h2 className="text-lg font-semibold">Sources</h2>
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
                {visibleDocuments.map((doc) => {
                  const { primary, original } = documentTitles(doc);
                  return (
                  // The row is a link, but the identity menu inside it is a
                  // button — so the link is the title with a stretched hit
                  // area (::after) and the menu sits above it on z-10, rather
                  // than a button nested inside an anchor.
                  <div
                    key={doc._id}
                    className="relative flex items-center justify-between py-1.5 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors"
                  >
                    <span className="flex items-start gap-1.5 min-w-0">
                      <DocumentIdentityMenu
                        document={doc}
                        className="relative z-10 mt-0.5"
                      />
                      <span className="flex flex-col min-w-0">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <Link
                            to={`/documents/${doc._id}`}
                            className="text-sm truncate after:absolute after:inset-0 after:content-['']"
                          >
                            {primary}
                          </Link>
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
                      <DocStatusIndicator status={doc.status} mediaType={doc.mediaType} mimeType={doc.mimeType} />
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
    </div>
  );
}

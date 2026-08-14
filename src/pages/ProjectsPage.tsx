import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link, useNavigate } from "react-router";
import { FolderOpen, MoreVertical, Plus, Search, X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type ProjectListItem = Doc<"projects"> & { documentCount: number };

/**
 * A project in the picker grid. The folder icon turns into a ⋮ on hover (and
 * on keyboard focus), and clicking it edits the title and description in
 * place — no menu, no AI, just the two text fields the card already shows.
 */
function ProjectCard({ project }: { project: ProjectListItem }) {
  const updateProject = useMutation(api.projects.update);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [saving, setSaving] = useState(false);

  function startEditing() {
    // Re-seed from the document: the card may have been re-rendered with a
    // newer name since these drafts were initialized.
    setName(project.name);
    setDescription(project.description ?? "");
    setEditing(true);
  }

  async function save() {
    const trimmed = name.trim();
    // The mutation rejects an empty name, and an empty card would be
    // unrecognizable anyway — treat it as "not done typing yet".
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await updateProject({
        id: project._id,
        name: trimmed,
        description: description.trim(),
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={name}
            autoFocus
            aria-label="Project name"
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-full min-w-0 rounded border bg-background px-2 py-1 text-sm font-medium outline-none focus:ring-2 focus:ring-ring/30"
          />
        </div>
        <textarea
          value={description}
          rows={2}
          aria-label="Project description"
          placeholder="Description (optional)"
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves, Shift+Enter starts a new line — same convention as
            // the document identity menu.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") setEditing(false);
          }}
          className="mt-2 w-full resize-none rounded border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring/30 placeholder:text-muted-foreground"
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!name.trim() || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    // The whole card navigates, but the icon inside it is its own button —
    // so the title link carries a stretched hit area (::after) and the icon
    // sits above it on z-10, rather than nesting a button inside the link.
    <div className="relative rounded-lg border bg-card p-4 hover:bg-accent/50 transition-colors">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={startEditing}
          title="Rename project"
          aria-label="Rename project"
          className="group/identity relative z-10 grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FolderOpen className="col-start-1 row-start-1 h-4 w-4 text-muted-foreground transition-opacity group-hover/identity:opacity-0 group-focus-visible/identity:opacity-0" />
          <MoreVertical className="col-start-1 row-start-1 h-3.5 w-3.5 opacity-0 transition-opacity group-hover/identity:opacity-100 group-focus-visible/identity:opacity-100" />
        </button>
        <Link
          to={`/p/${project._id}`}
          className="min-w-0 truncate text-left text-sm font-medium after:absolute after:inset-0 after:content-['']"
        >
          {project.name}
        </Link>
      </div>
      {project.description && (
        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
          {project.description}
        </p>
      )}
      <p className="text-xs text-muted-foreground mt-2">
        {project.documentCount >= 500 ? "500+" : project.documentCount} document
        {project.documentCount !== 1 && "s"} ·{" "}
        {new Date(project.createdAt).toLocaleDateString()}
      </p>
    </div>
  );
}

export default function ProjectsPage() {
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  const allProjects = useQuery(api.projects.list);
  const searchResults = useQuery(
    api.projects.search,
    debounced.trim() ? { q: debounced.trim() } : "skip"
  );
  const projects = debounced.trim() ? searchResults : allProjects;

  const createProject = useMutation(api.projects.create);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const projectId = await createProject({ name: newName.trim() });
      navigate(`/p/${projectId}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col">
      <header className="border-b px-6 py-4 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">Document Intelligence</h1>
          <p className="text-sm text-muted-foreground">
            Pick a project — each one is its own corpus with its own entities and
            connections.
          </p>
        </div>
      </header>

      <div className="flex-1">
        <div className="max-w-3xl mx-auto p-6">
          {/* Search across projects */}
          <div className="relative mb-6 mt-2">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              autoFocus
              className="w-full h-12 pl-11 pr-4 rounded-xl border bg-card text-[15px] shadow-sm outline-none transition-shadow focus:shadow-md focus:ring-2 focus:ring-ring/30 placeholder:text-muted-foreground"
            />
          </div>

          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Projects</h2>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {showCreateForm ? (
                <>
                  <X className="h-3.5 w-3.5" /> Cancel
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" /> New Project
                </>
              )}
            </button>
          </div>

          {showCreateForm && (
            <form onSubmit={handleCreate} className="flex gap-2 mb-4">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Project name…"
                className="flex-1 text-sm border rounded px-3 py-1.5 bg-background"
                autoFocus
              />
              <button
                type="submit"
                disabled={creating}
                className="text-sm px-3 py-1.5 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </form>
          )}

          {projects === undefined ? (
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center border rounded-lg">
              {debounced.trim()
                ? "No projects match this search."
                : "No projects yet. Create one to get started."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {projects.map((project) => (
                <ProjectCard key={project._id} project={project} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

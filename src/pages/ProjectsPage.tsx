import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link, useNavigate } from "react-router";
import { FolderOpen, MoreVertical, Plus, Trash2, X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import { PageShell, SectionHeading } from "@/components/ui/page-shell";
import { SearchField } from "@/components/ui/search-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/use-confirm";
import { counted, plural } from "@/lib/plural";

type ProjectListItem = Doc<"projects"> & { documentCount: number };

/**
 * A project in the picker grid. The folder icon turns into a ⋮ on hover (and
 * on keyboard focus), and clicking it edits the title and description in
 * place — no menu, no AI, just the two text fields the card already shows.
 */
function ProjectCard({ project }: { project: ProjectListItem }) {
  const updateProject = useMutation(api.projects.update);
  const removeProject = useMutation(api.projects.remove);
  const confirm = useConfirm();

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

  /**
   * Deleting a project takes every document, entity and search in it — by far
   * the most destructive thing in the app — so the prompt names the project and
   * says how much goes with it rather than asking a generic "are you sure".
   */
  async function handleDelete() {
    const documents =
      project.documentCount >= 500
        ? "500+ documents"
        : counted(project.documentCount, "document");
    const ok = await confirm({
      title: `Permanently delete “${project.name}”?`,
      body: `This deletes the project and its ${documents}, along with every page, entity, extraction and saved search inside it. It cannot be undone.`,
      confirmLabel: "Delete project",
      tone: "destructive",
    });
    if (!ok) return;
    await removeProject({ id: project._id });
  }

  if (editing) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
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
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-auto gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={saving}
            onClick={() => void handleDelete()}
          >
            <Trash2 className="size-3.5" />
            Delete project
          </Button>
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
          className="group/identity relative z-10 grid size-5 shrink-0 place-items-center rounded hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <FolderOpen className="col-start-1 row-start-1 size-4 text-muted-foreground transition-opacity group-hover/identity:opacity-0 group-focus-visible/identity:opacity-0" />
          <MoreVertical className="col-start-1 row-start-1 size-3.5 opacity-0 transition-opacity group-hover/identity:opacity-100 group-focus-visible/identity:opacity-100" />
        </button>
        <Link
          to={`/p/${project.slug}`}
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
      <p className="mt-2 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">
          {project.documentCount >= 500 ? "500+" : project.documentCount}
        </span>{" "}
        {plural(project.documentCount, "document")} ·{" "}
        <span className="font-mono tabular-nums">
          {new Date(project.createdAt).toLocaleDateString()}
        </span>
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
      const { slug } = await createProject({ name: newName.trim() });
      navigate(`/p/${slug}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <PageShell
      width="prose"
      title="Document Intelligence"
      subtitle="Pick a project — each one is its own corpus with its own entities and connections."
    >
      <SearchField
        className="mb-6"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search projects…"
        aria-label="Search projects"
      />

      <SectionHeading
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCreateForm(!showCreateForm)}
          >
            {showCreateForm ? (
              <>
                <X className="size-3.5" /> Cancel
              </>
            ) : (
              <>
                <Plus className="size-3.5" /> New Project
              </>
            )}
          </Button>
        }
      >
        Projects
      </SectionHeading>

      {showCreateForm && (
        <form onSubmit={handleCreate} className="mb-4 flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Project name…"
            aria-label="New project name"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={creating} className="shrink-0">
            {creating ? "Creating…" : "Create"}
          </Button>
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
        <EmptyState
          title={
            debounced.trim()
              ? "No projects match this search."
              : "No projects yet."
          }
          description={
            debounced.trim() ? undefined : "Create one to get started."
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {projects.map((project) => (
            <ProjectCard key={project._id} project={project} />
          ))}
        </div>
      )}
    </PageShell>
  );
}

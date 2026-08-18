import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Link } from "react-router";
import { FolderOpen, Settings2 } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import { PageShell, SectionHeading } from "@/components/ui/page-shell";
import { SearchField } from "@/components/ui/search-field";
import { EmptyState } from "@/components/ui/empty-state";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";
import { plural } from "@/lib/plural";

type ProjectListItem = Doc<"projects"> & { documentCount: number };

/**
 * A project in the picker grid — pure navigation. The folder icon turns into
 * a settings glyph on hover (and on keyboard focus) and links to the
 * project's settings, which is where its name, description and deletion
 * live; the card stopped hosting its own editor when that page took them
 * over, so one row of the projects table has one editing home.
 */
function ProjectCard({ project }: { project: ProjectListItem }) {
  return (
    // The whole card navigates, but the icon inside it is its own link —
    // so the title link carries a stretched hit area (::after) and the icon
    // sits above it on z-10, rather than nesting a link inside the link.
    <div className="relative rounded-lg border bg-card p-4 hover:bg-accent/50 transition-colors">
      <div className="flex items-center gap-2">
        <Link
          to={`/p/${project.slug}/settings`}
          title="Project settings"
          aria-label={`Settings for ${project.name}`}
          className="group/identity relative z-10 grid size-5 shrink-0 place-items-center rounded hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <FolderOpen className="col-start-1 row-start-1 size-4 text-muted-foreground transition-opacity group-hover/identity:opacity-0 group-focus-visible/identity:opacity-0" />
          <Settings2 className="col-start-1 row-start-1 size-3.5 opacity-0 transition-opacity group-hover/identity:opacity-100 group-focus-visible/identity:opacity-100" />
        </Link>
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

  return (
    <PageShell
      width="prose"
      title={
        <span className="flex items-center gap-2">
          {/* Black line art, so it needs inverting to stay visible in dark. */}
          <img
            src="/haystack.png"
            alt=""
            className="size-6 shrink-0 object-contain dark:invert"
          />
          Haystack
        </span>
      }
      subtitle="Pick a project — each one is its own corpus with its own entities and connections."
    >
      <SearchField
        className="mb-6"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search projects…"
        aria-label="Search projects"
      />

      <SectionHeading actions={<NewProjectDialog />}>Projects</SectionHeading>

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

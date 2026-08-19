import { Link } from "react-router";
import type { Route } from "./+types/ProjectEntitiesPage";
import { usePaginatedQuery, useQuery } from "convex/react";
import { Star } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { PageShell } from "@/components/ui/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { entitySlug } from "@/lib/entitySlug";
import { counted } from "@/lib/plural";

const PAGE_SIZE = 100;

/**
 * Every entity in the project, paginated — where the sidebar's "View all"
 * lands. The sidebar shows a capped, curated slice; this page owes the user
 * the whole list, so it pages instead of capping.
 */
export default function ProjectEntitiesPage({ params }: Route.ComponentProps) {
  const project = useQuery(api.projects.getBySlug, { slug: params.slug });
  const projectId = project?._id;
  const { results, status, loadMore } = usePaginatedQuery(
    api.entities.listPaginated,
    projectId ? { projectId } : "skip",
    { initialNumItems: PAGE_SIZE }
  );

  if (project === null) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Project not found.</p>
        <Link to="/" className="mt-2 inline-block text-sm underline">
          Back to home
        </Link>
      </div>
    );
  }

  return (
    <PageShell
      back={{ to: `/p/${params.slug}`, label: "Back to project" }}
      breadcrumb={
        <Link to={`/p/${params.slug}`} className="hover:underline">
          {params.slug}
        </Link>
      }
      title="Entities"
      subtitle={
        status === "Exhausted"
          ? `All ${counted(results.length, "entity", "entities")}, most mentioned first`
          : "Most mentioned first"
      }
    >
      {project === undefined || (results.length === 0 && status === "LoadingFirstPage") ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : results.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No entities found yet. Open a document and run an extraction.
        </p>
      ) : (
        <>
          <div className="flex flex-col">
            {results.map((entity) => (
              <Link
                key={entity._id}
                to={`/entity/${entity.slug ?? entitySlug(entity.name)}?project=${entity.projectId}`}
                className="flex items-baseline gap-3 border-b border-border/60 py-2 last:border-b-0 hover:bg-accent/50"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {entity.name}
                  {entity.starred && (
                    <Star
                      aria-label="Starred"
                      className="ml-1.5 inline size-3 text-amber-500"
                      fill="currentColor"
                    />
                  )}
                </span>
                {(entity.types ?? [entity.type]).map((t) => (
                  <Badge
                    key={t}
                    variant="outline"
                    className="hidden shrink-0 capitalize sm:inline-flex"
                  >
                    {t}
                  </Badge>
                ))}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {counted(entity.mentionCount, "mention")} ·{" "}
                  {counted(entity.documentCount, "document")}
                </span>
              </Link>
            ))}
          </div>
          {status !== "Exhausted" && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                disabled={status === "LoadingMore"}
                onClick={() => loadMore(PAGE_SIZE)}
              >
                {status === "LoadingMore" ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}

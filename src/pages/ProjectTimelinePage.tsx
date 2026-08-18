import { useParams } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectTimeline } from "@/components/timeline/ProjectTimeline";

/** The project's documents laid out by the dates they claim for themselves. */
export default function ProjectTimelinePage() {
  const { slug = "" } = useParams();
  const project = useQuery(api.projects.getBySlug, slug ? { slug } : "skip");
  const documents = useQuery(
    api.documents.list,
    project ? { projectId: project._id } : "skip",
  );
  const eventResult = useQuery(
    api.relationships.forProjectTimeline,
    project ? { projectId: project._id } : "skip",
  );

  if (project === null) {
    return (
      <PageShell title="Project not found" back={{ to: "/", label: "All projects" }}>
        <EmptyState
          title="This project doesn't exist or isn't yours."
          description="Check the link, or head back to your projects."
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Timeline"
      breadcrumb={project?.name}
      subtitle={
        documents
          ? `${documents.length} document${documents.length === 1 ? "" : "s"} in this project`
          : undefined
      }
      back={{ to: `/p/${slug}`, label: "Back to project" }}
    >
      {documents === undefined ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <ProjectTimeline
          documents={documents}
          events={eventResult?.events ?? []}
          eventsCapped={eventResult?.capped ?? false}
        />
      )}
    </PageShell>
  );
}

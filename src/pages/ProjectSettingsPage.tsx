import { useQuery } from "convex/react";
import { Link } from "react-router";
import type { Route } from "./+types/ProjectSettingsPage";
import { api } from "../../convex/_generated/api";
import { DocumentCategoriesSettings } from "@/components/settings/DocumentCategoriesSettings";
import { ProjectDetailsSettings } from "@/components/settings/ProjectDetailsSettings";
import { ProjectEntityTypesSettings } from "@/components/settings/ProjectEntityTypesSettings";
import { PageShell, SectionHeading } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * What one project decides for itself.
 *
 * The taxonomy used to live on the app-wide settings page, which was the wrong
 * place the moment two projects wanted different categories: a biology corpus
 * and a litigation corpus disagree about what a document even is. /settings
 * keeps what is genuinely deployment-wide — usage, provider health, the
 * processing queue, the default language.
 */
export default function ProjectSettingsPage({ params }: Route.ComponentProps) {
  const project = useQuery(api.projects.getBySlug, { slug: params.slug });

  if (project === undefined) {
    return (
      <PageShell title="Project settings" back={{ to: "/", label: "Back to projects" }}>
        <Skeleton className="h-64 w-full" />
      </PageShell>
    );
  }

  if (project === null) {
    return (
      <PageShell title="Project settings" back={{ to: "/", label: "Back to projects" }}>
        <p className="text-sm text-muted-foreground">
          No project at this address.{" "}
          <Link to="/" className="underline">
            Back to projects
          </Link>
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell
      width="prose"
      title="Project settings"
      breadcrumb={<Link to={`/p/${project.slug}`}>{project.name}</Link>}
      subtitle="What this project looks for, and how it files what it finds."
      back={{ to: `/p/${project.slug}`, label: `Back to ${project.name}` }}
    >
      <SectionHeading>Project details</SectionHeading>
      <ProjectDetailsSettings project={project} />

      <SectionHeading>Document types</SectionHeading>
      <p className="mb-3 text-sm text-muted-foreground">
        The types Analyze sorts every document in this project into. Add your
        own, or adjust how the ones your template started with are described —
        the description is what the model is told the bucket means.
      </p>
      <DocumentCategoriesSettings projectId={project._id} />

      <SectionHeading>Entity types</SectionHeading>
      <p className="mb-3 text-sm text-muted-foreground">
        What this project looks for besides people and organizations.
      </p>
      <ProjectEntityTypesSettings projectId={project._id} />
    </PageShell>
  );
}

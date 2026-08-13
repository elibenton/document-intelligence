import { useParams, useSearchParams, Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { QuotePreview } from "@/components/entities/QuotePreview";
import {
  ConnectionTimeline,
  CounterpartyStrip,
  GroupedConnections,
} from "@/components/entities/EntityConnections";

const toSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export default function EntityPage() {
  const { slug } = useParams<{ slug: string }>();
  // Entities are per-project, so the slug alone is ambiguous — ?project=
  // disambiguates it. Links minted before scoping existed omit it and fall
  // back to a global lookup.
  const [searchParams] = useSearchParams();
  const projectParam = searchParams.get("project") as Id<"projects"> | null;
  const entity = useQuery(api.entities.getBySlug, {
    slug: slug ?? "",
    ...(projectParam ? { projectId: projectParam } : {}),
  });
  // Prefer the resolved entity's own project for outbound links.
  const linkProjectId = entity?.projectId ?? projectParam ?? null;
  const entityLink = (name: string) =>
    `/entity/${toSlug(name)}${linkProjectId ? `?project=${linkProjectId}` : ""}`;
  const documents = useQuery(
    api.entities.documentsForEntity,
    entity ? { entityId: entity._id } : "skip"
  );
  const connections = useQuery(
    api.relationships.forEntity,
    entity ? { entityId: entity._id } : "skip"
  );
  const roles = useQuery(
    api.roles.forEntity,
    entity ? { entityId: entity._id } : "skip"
  );
  const mentionGroups = useQuery(
    api.entities.mentionsForEntity,
    entity ? { entityId: entity._id } : "skip"
  );

  if (entity === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
    );
  }

  if (entity === null) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Entity not found.</p>
        <Link to="/" className="text-sm underline mt-2 inline-block">
          Back to home
        </Link>
      </div>
    );
  }

  const typeLabels: Record<string, string> = {
    people: "Person",
    person: "Person",
    organization: "Organization",
    places: "Place",
    place: "Place",
    dates: "Date",
    other: "Other",
  };

  return (
    <div className="flex flex-col">
      <header className="border-b px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Link
            to={entity.projectId ? `/p/${entity.projectId}` : "/"}
            className="hover:text-foreground"
          >
            Project
          </Link>
          <span>/</span>
          <span>{entity.name}</span>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">{entity.name}</h1>
          {(entity.types ?? [entity.type]).map((t) => (
            <Badge key={t} variant="outline" className="text-xs capitalize">
              {typeLabels[t] ?? t}
            </Badge>
          ))}
        </div>
        {/* Contextual roles this entity plays, per document */}
        {roles && roles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {roles.map((r) => (
              <Badge
                key={r._id}
                variant="secondary"
                className="text-xs capitalize"
                title={r.document ? `${r.role} in ${r.document.name}` : r.role}
              >
                {r.role}
                {r.document && (
                  <span className="normal-case text-muted-foreground ml-1">
                    · {r.document.name}
                  </span>
                )}
              </Badge>
            ))}
          </div>
        )}
        <p className="text-sm text-muted-foreground mt-1">
          {entity.mentionCount} mention{entity.mentionCount !== 1 && "s"} across{" "}
          {entity.documentCount} document{entity.documentCount !== 1 && "s"}
        </p>
      </header>

      <div className="flex-1 p-6">
        {connections === undefined ? (
          <div className="space-y-2 mb-6">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : connections.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground mb-6">
            No mapped relationships yet.
          </p>
        ) : (
          <div className="mb-6 flex flex-col gap-6">
            {connections.counterparties.length > 1 && (
              <section>
                <h2 className="text-lg font-semibold mb-2">Most connected</h2>
                <CounterpartyStrip
                  counterparties={connections.counterparties}
                  entityLink={entityLink}
                />
              </section>
            )}

            <section>
              <h2 className="text-lg font-semibold mb-3">Connections</h2>
              <GroupedConnections
                connections={connections.connections}
                subjectName={entity.name}
                entityLink={entityLink}
              />
            </section>

            <section>
              <h2 className="text-lg font-semibold mb-3">Timeline</h2>
              <ConnectionTimeline
                connections={connections.connections}
                subjectName={entity.name}
                entityLink={entityLink}
              />
            </section>
          </div>
        )}

        <h2 className="text-lg font-semibold mb-3">Appears In</h2>

        {documents === undefined ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No document mentions found.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {documents.map((doc) => {
              const group = mentionGroups?.find(
                (g) => g.document._id === doc._id
              );
              return (
                <div key={doc._id} className="border rounded-md px-3 py-2">
                  <Link
                    to={`/documents/${doc._id}`}
                    className="flex items-center justify-between rounded hover:bg-accent/50 transition-colors"
                  >
                    <span className="text-sm font-medium truncate">
                      {doc.name}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 ml-3">
                      {doc.mentionCount} mention{doc.mentionCount !== 1 && "s"}
                    </span>
                  </Link>
                  {group && group.mentions.length > 0 && (
                    <div className="mt-1.5 flex flex-col gap-1">
                      {group.mentions.map((m, i) => (
                        <QuotePreview
                          key={i}
                          target={{
                            documentId: group.document._id,
                            fileUrl: group.fileUrl,
                            mediaType: group.document.mediaType,
                            pageNumber: m.pageNumber,
                            bbox: m.bbox,
                            pageWidth: m.pageWidth,
                            pageHeight: m.pageHeight,
                          }}
                          highlight={entity.name}
                        >
                          <p className="text-xs text-muted-foreground pl-2 border-l-2 border-border cursor-help">
                            <span className="text-foreground/70 font-medium">
                              p.{m.pageNumber + 1}
                            </span>{" "}
                            “{m.snippet}”
                          </p>
                        </QuotePreview>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {entity.aliases.length > 0 && (
          <div className="mt-6">
            <h2 className="text-lg font-semibold mb-2">Aliases</h2>
            <div className="flex flex-wrap gap-2">
              {entity.aliases.map((alias) => (
                <Badge key={alias} variant="secondary" className="text-xs">
                  {alias}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

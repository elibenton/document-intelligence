import { useEffect, useState } from "react";
import { useSearchParams, Link, useNavigate } from "react-router";
import type { Route } from "./+types/EntityPage";
import { useMutation, useQuery } from "convex/react";
import { Star, X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EditableText } from "@/components/ui/editable";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { QuotePreview } from "@/components/entities/QuotePreview";
import { MergeSuggestions } from "@/components/entities/MergeSuggestions";
import { ProjectSearchDialog } from "@/components/search/ProjectSearchDialog";
import {
  ConnectionTimeline,
  CounterpartyStrip,
  GroupedConnections,
} from "@/components/entities/EntityConnections";
import { DocTypePills } from "@/components/documents/DocTypePills";
import { entitySlug } from "@/lib/entitySlug";
import { formatDocumentDate, hasDocumentDate } from "@/lib/documentDate";
import { PageShell, SectionHeading } from "@/components/ui/page-shell";
import { counted } from "@/lib/plural";
import { useProjectSlug } from "@/hooks/useProjectSlug";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  people: "Person",
  person: "Person",
  organization: "Organization",
  places: "Place",
  place: "Place",
  dates: "Date",
  other: "Other",
};

export default function EntityPage({ params }: Route.ComponentProps) {
  const { slug } = params;
  const navigate = useNavigate();
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
  const projectSlug = useProjectSlug(linkProjectId);
  const entityLink = (name: string) =>
    `/entity/${entitySlug(name)}${linkProjectId ? `?project=${linkProjectId}` : ""}`;
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
  const suggestions = useQuery(
    api.mergeSuggestions.forEntity,
    entity ? { entityId: entity._id } : "skip"
  );

  const renameEntity = useMutation(api.entities.rename);
  const setStarred = useMutation(api.entities.setStarred);
  const addAlias = useMutation(api.entities.addAlias);
  const removeAlias = useMutation(api.entities.removeAlias);

  // A merge that this entity loses deletes it under our feet: getBySlug
  // flips from a row to null. Walking back to the project beats rendering
  // "Entity not found" over work the user just confirmed.
  const [hadEntity, setHadEntity] = useState(false);
  if (entity && !hadEntity) setHadEntity(true);
  useEffect(() => {
    if (entity === null && hadEntity) {
      void navigate(projectSlug ? `/p/${projectSlug}` : "/", { replace: true });
    }
  }, [entity, hadEntity, navigate, projectSlug]);

  const [aliasDraft, setAliasDraft] = useState("");

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

  // One badge per role name, not one per (role, document): ten documents
  // asserting "declarant" is one fact with ten sources, so the count folds
  // in and the sources live in the title.
  const roleGroups = new Map<string, string[]>();
  for (const r of roles ?? []) {
    const docs = roleGroups.get(r.role) ?? [];
    if (r.document) docs.push(r.document.name);
    roleGroups.set(r.role, docs);
  }

  const starred = entity.starred === true;

  return (
    <>
      {linkProjectId && <ProjectSearchDialog projectId={linkProjectId} />}
      <PageShell
        back={{ to: projectSlug ? `/p/${projectSlug}` : "/", label: "Back to project" }}
        breadcrumb={
          projectSlug ? (
            <Link to={`/p/${projectSlug}`} className="hover:underline">
              {projectSlug}
            </Link>
          ) : undefined
        }
        title={
          <span className="flex items-baseline gap-2.5">
            <EditableText
              value={entity.name}
              label="Rename entity"
              allowEmpty={false}
              className="truncate text-xl font-semibold"
              onCommit={(name) => renameEntity({ id: entity._id, name })}
            />
            {(entity.types ?? [entity.type]).map((t) => (
              <Badge key={t} variant="outline" className="shrink-0 capitalize">
                {TYPE_LABELS[t] ?? t}
              </Badge>
            ))}
          </span>
        }
        subtitle={
          <span className="tabular-nums">
            {counted(entity.mentionCount, "mention")} across{" "}
            {counted(entity.documentCount, "document")}
          </span>
        }
        actions={
          <button
            type="button"
            aria-label={starred ? "Unstar entity" : "Star entity"}
            title={starred ? "Unstar entity" : "Star entity"}
            onClick={() => void setStarred({ id: entity._id, starred: !starred })}
            className={cn(
              "grid size-8 place-items-center rounded-md transition-colors",
              "hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
              starred ? "text-amber-500" : "text-muted-foreground/45 hover:text-amber-500"
            )}
          >
            <Star className="size-4" fill={starred ? "currentColor" : "none"} />
          </button>
        }
      >
        {/* Identity strip: aliases (editable — every alias is a way this
            entity gets found) and deduplicated roles. */}
        <div className="mb-6 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {entity.aliases.map((alias) => (
              <Badge key={alias} variant="secondary" className="gap-1 text-xs">
                {alias}
                <button
                  type="button"
                  aria-label={`Remove alias ${alias}`}
                  onClick={() => void removeAlias({ id: entity._id, alias })}
                  className="grid size-3.5 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-2.5" />
                </button>
              </Badge>
            ))}
            <Input
              value={aliasDraft}
              onChange={(e) => setAliasDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && aliasDraft.trim()) {
                  e.preventDefault();
                  void addAlias({ id: entity._id, alias: aliasDraft.trim() });
                  setAliasDraft("");
                }
              }}
              placeholder="Add alias…"
              aria-label="Add alias"
              className="h-6 w-28 text-xs"
            />
          </div>
          {roleGroups.size > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {[...roleGroups.entries()].map(([role, docs]) => (
                <Badge
                  key={role}
                  variant="secondary"
                  className="capitalize"
                  title={docs.length ? `${role} in: ${docs.join(", ")}` : role}
                >
                  {role}
                  {docs.length > 1 && (
                    <span className="ml-1 normal-case text-muted-foreground">
                      ×{docs.length}
                    </span>
                  )}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* A pending duplicate is the most actionable fact about an entity —
            it goes above the fold, not on another page. */}
        {suggestions && suggestions.length > 0 && (
          <div className="mb-6">
            <MergeSuggestions suggestions={suggestions} />
          </div>
        )}

        <div>
          {connections === undefined ? (
            <div className="space-y-2 mb-6">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : connections.connections.length === 0 ? (
            <EmptyState variant="inline" title="No mapped relationships yet." />
          ) : (
            <section className="mb-6">
              <SectionHeading>Connections</SectionHeading>
              {connections.counterparties.length > 1 && (
                <div className="mb-3">
                  <CounterpartyStrip
                    counterparties={connections.counterparties}
                    entityLink={entityLink}
                  />
                </div>
              )}
              {/* One render of the rows, two ways to read them — the old page
                  drew the same connections three times in a column. */}
              <Tabs defaultValue="relations">
                <TabsList>
                  <TabsTrigger value="relations">By relation</TabsTrigger>
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                </TabsList>
                <TabsContent value="relations">
                  <GroupedConnections
                    connections={connections.connections}
                    subjectName={entity.name}
                    entityLink={entityLink}
                  />
                </TabsContent>
                <TabsContent value="timeline">
                  <ConnectionTimeline
                    connections={connections.connections}
                    subjectName={entity.name}
                    entityLink={entityLink}
                  />
                </TabsContent>
              </Tabs>
            </section>
          )}

          <SectionHeading>Appears In</SectionHeading>

          {documents === undefined ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : documents.length === 0 ? (
            <EmptyState variant="inline" title="No document mentions found." />
          ) : (
            <div className="flex flex-col gap-3">
              {documents.map((doc) => {
                const group = mentionGroups?.find(
                  (g) => g.document._id === doc._id
                );
                const firstMention = group?.mentions[0];
                const title = doc.displayName?.trim() || doc.name;
                // Land on the first mention, highlighted — the page and
                // bbox were always in hand, the link just never used them.
                const href = firstMention
                  ? `/documents/${doc._id}?page=${firstMention.pageNumber + 1}&highlight=${encodeURIComponent(entity.name)}`
                  : `/documents/${doc._id}`;
                return (
                  <div key={doc._id} className="border rounded-md px-3 py-2">
                    <Link
                      to={href}
                      className="flex items-center gap-3 rounded hover:bg-accent/50 transition-colors"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {title}
                      </span>
                      <DocTypePills
                        projectId={doc.projectId}
                        primaryCategory={doc.primaryCategory}
                        primaryKind={doc.primaryKind}
                        className="hidden sm:inline-flex"
                      />
                      {hasDocumentDate(doc) && (
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatDocumentDate(doc)}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground shrink-0">
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
                            <Link
                              to={`/documents/${doc._id}?page=${m.pageNumber + 1}&highlight=${encodeURIComponent(entity.name)}`}
                              className="block text-xs text-muted-foreground pl-2 border-l-2 border-border hover:border-foreground/40 hover:text-foreground"
                            >
                              <span className="text-foreground/70 font-medium">
                                p.{m.pageNumber + 1}
                              </span>{" "}
                              “{m.snippet}”
                            </Link>
                          </QuotePreview>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PageShell>
    </>
  );
}

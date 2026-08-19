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
import { EmptyState } from "@/components/ui/empty-state";
import { QuotePreview } from "@/components/entities/QuotePreview";
import { MergeSuggestions } from "@/components/entities/MergeSuggestions";
import { ProjectSearchDialog } from "@/components/search/ProjectSearchDialog";
import {
  BioLede,
  BioTimeline,
  ConnectedToList,
  FactList,
  GeneratedLede,
} from "@/components/entities/EntityBio";
import { buildBioModel, buildLede } from "@/lib/entityBio";
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

/** How many distinct roles lead the page before the rest fold into the infobox. */
const LEDE_ROLES = 4;

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
  const ensureDescription = useMutation(api.descriptions.ensure);
  // Viewing an entity is what makes its description worth having: ensure()
  // compares the stored description against the live fact set and schedules
  // a regeneration only on mismatch — a no-op on the common path.
  const entityId = entity?._id;
  useEffect(() => {
    if (!entityId) return;
    ensureDescription({ entityId }).catch(() => {
      // A missing description is a nicety the page renders fine without.
    });
  }, [entityId, ensureDescription]);
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

  // One entry per role name, most-asserted first: ten documents saying
  // "owner" is one fact with weight, and the strongest roles make the lede.
  const roleCounts = new Map<string, number>();
  for (const r of roles ?? []) {
    roleCounts.set(r.role, (roleCounts.get(r.role) ?? 0) + 1);
  }
  const rankedRoles = [...roleCounts.entries()].sort((a, b) => b[1] - a[1]);
  const ledeRoles = rankedRoles.slice(0, LEDE_ROLES).map(([role]) => role);

  const bio = buildBioModel(connections?.connections ?? []);
  const lede = buildLede(bio.facts);
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
          // The lede: what this entity is, on its own terms, before any list.
          ledeRoles.length > 0 ? (
            <span className="capitalize">{ledeRoles.join(" · ")}</span>
          ) : (
            <span className="tabular-nums">
              {counted(entity.mentionCount, "mention")} across{" "}
              {counted(entity.documentCount, "document")}
            </span>
          )
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
        {/* A pending duplicate is the most actionable fact about an entity —
            it goes above the fold, not on another page. */}
        {suggestions && suggestions.length > 0 && (
          <div className="mb-6">
            <MergeSuggestions suggestions={suggestions} />
          </div>
        )}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
          {/* ——— Main column: the article ——— */}
          <div className="min-w-0">
            {/* The AI-written description leads when it exists; the
                deterministic clause lede is the always-available fallback. */}
            {entity.description && entity.description.sentences.length > 0 ? (
              <div className="mb-8">
                <GeneratedLede
                  sentences={entity.description.sentences}
                  citeByConnection={bio.citeByConnection}
                  entityNames={[
                    ...new Set(
                      (connections?.connections ?? []).map(
                        (c) => c.otherEntity.name
                      )
                    ),
                  ]}
                  entityLink={entityLink}
                  highlight={entity.name}
                />
              </div>
            ) : (
              (lede.professional.length > 0 || lede.personal.length > 0) && (
                <div className="mb-8">
                  <BioLede
                    lede={lede}
                    entityLink={entityLink}
                    highlight={entity.name}
                  />
                </div>
              )
            )}
            {connections === undefined ? (
              <div className="space-y-2 mb-8">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : bio.facts.length === 0 ? (
              <div className="mb-8">
                <EmptyState variant="inline" title="No mapped relationships yet." />
              </div>
            ) : (
              <section className="mb-8">
                <SectionHeading>Relationships</SectionHeading>
                <FactList
                  facts={bio.facts}
                  entityLink={entityLink}
                  highlight={entity.name}
                />
              </section>
            )}

            {connections && connections.connections.length > 0 && (
              <section className="mb-8">
                <SectionHeading>Timeline</SectionHeading>
                <BioTimeline
                  connections={connections.connections}
                  citeByConnection={bio.citeByConnection}
                  entityLink={entityLink}
                  highlight={entity.name}
                />
              </section>
            )}

            <section>
              <SectionHeading>Appears In</SectionHeading>
              {documents === undefined ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ) : documents.length === 0 ? (
                <EmptyState variant="inline" title="No document mentions found." />
              ) : (
                <div className="flex flex-col">
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
                      <div
                        key={doc._id}
                        className="flex items-baseline gap-3 border-b border-border/60 py-2 last:border-b-0"
                      >
                        <Link
                          to={href}
                          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                        >
                          {title}
                        </Link>
                        {/* Mentions as page citations: the evidence is one
                            hover away, not a paragraph on the page. */}
                        {group && group.mentions.length > 0 && (
                          <span className="shrink-0 text-xs text-muted-foreground">
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
                                  title={`“${m.snippet}”`}
                                  className="hover:text-primary hover:underline"
                                >
                                  {i > 0 && ", "}
                                  p.{m.pageNumber + 1}
                                </Link>
                              </QuotePreview>
                            ))}
                          </span>
                        )}
                        <DocTypePills
                          projectId={doc.projectId}
                          primaryCategory={doc.primaryCategory}
                          primaryKind={doc.primaryKind}
                          className="hidden sm:inline-flex shrink-0"
                        />
                        {hasDocumentDate(doc) && (
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {formatDocumentDate(doc)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          {/* ——— Infobox: identity at a glance ——— */}
          <aside className="order-first lg:order-none">
            <div className="rounded-lg border bg-card px-4 py-3 lg:sticky lg:top-4">
              <dl className="flex flex-col gap-3">
                <div>
                  <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Also known as
                  </dt>
                  <dd className="flex flex-wrap items-center gap-1.5">
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
                  </dd>
                </div>

                {rankedRoles.length > 0 && (
                  <div>
                    <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Roles
                    </dt>
                    <dd className="text-sm leading-relaxed capitalize">
                      {rankedRoles.map(([role, count], i) => (
                        <span key={role}>
                          {i > 0 && <span className="text-muted-foreground/60"> · </span>}
                          {role}
                          {count > 1 && (
                            <span className="text-xs text-muted-foreground"> ×{count}</span>
                          )}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}

                {connections && connections.counterparties.length > 0 && (
                  <div>
                    <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Connected to
                    </dt>
                    <dd>
                      <ConnectedToList
                        counterparties={connections.counterparties}
                        entityLink={entityLink}
                      />
                    </dd>
                  </div>
                )}

                <div>
                  <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    In this project
                  </dt>
                  <dd className="text-sm tabular-nums text-muted-foreground">
                    {counted(entity.mentionCount, "mention")} across{" "}
                    {counted(entity.documentCount, "document")}
                  </dd>
                </div>
              </dl>
            </div>
          </aside>
        </div>
      </PageShell>
    </>
  );
}

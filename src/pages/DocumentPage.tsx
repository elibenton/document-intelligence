import { useState, useCallback, useRef, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { PdfViewer } from "@/components/viewer/PdfViewer";
import { ViewerLayout } from "@/components/viewer/ViewerLayout";
import { TableOfContents } from "@/components/viewer/TableOfContents";
import { BlockOverlay } from "@/components/viewer/BlockOverlay";
import {
  PersonHighlight,
  findPersonMentions,
} from "@/components/viewer/PersonHighlight";
import { ProcessingStatus } from "@/components/documents/ProcessingStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { Id } from "../../convex/_generated/dataModel";

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const documentId = id as Id<"documents">;
  const document = useQuery(api.documents.get, { id: documentId });
  const url = useQuery(
    api.documents.getUrl,
    document ? { storageId: document.storageId } : "skip"
  );
  const blocks = useQuery(api.blocks.byDocument, { documentId });
  const pages = useQuery(api.pages.byDocument, { documentId });
  const extractions = useQuery(api.extractions.byDocument, { documentId });
  const runExtraction = useAction(api.processing.runExtraction);
  const runResearch = useAction(api.research.runResearch);
  const researchDossiers = useQuery(api.researchQueries.byDocument, { documentId });
  const documentEntities = useQuery(api.entities.byDocument, { documentId });

  const [currentPage, setCurrentPage] = useState(1);
  const [showBlocks, setShowBlocks] = useState(false);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [customTitle, setCustomTitle] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customExtracting, setCustomExtracting] = useState(false);
  const [presetExtracting, setPresetExtracting] = useState<Set<string>>(new Set());
  const [researching, setResearching] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);

  const handleVisiblePageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  const scrollToPage = useCallback(
    (page: number) => {
      const container = viewerContainerRef.current;
      if (container) {
        const scrollContainer = container.querySelector(
          "[data-page-number]"
        )?.parentElement?.parentElement?.parentElement;
        if (
          scrollContainer &&
          "scrollToPage" in scrollContainer &&
          typeof scrollContainer.scrollToPage === "function"
        ) {
          scrollContainer.scrollToPage(page);
        }
      }
    },
    []
  );

  // Parse people from extraction results
  const people = useMemo(() => {
    const peopleExtraction = extractions?.find((e) => {
      try {
        const schema = JSON.parse(e.schemaUsed);
        return schema?.properties?.people;
      } catch {
        return false;
      }
    });
    if (!peopleExtraction) return [];
    try {
      const parsed = JSON.parse(peopleExtraction.results);
      return Array.isArray(parsed?.people) ? (parsed.people as string[]) : [];
    } catch {
      return [];
    }
  }, [extractions]);

  // All entity groups: people first, then custom extractions
  const entityGroups = useMemo(() => {
    if (!extractions) return people.length > 0 ? [{ id: "people", title: "People", items: people }] : [];
    const groups: { id: string; title: string; items: string[] }[] = [];

    // People always first
    if (people.length > 0) {
      groups.push({ id: "people", title: "People", items: people });
    }

    // Custom extractions
    for (const e of extractions) {
      try {
        const schema = JSON.parse(e.schemaUsed);
        if (schema?.properties?.people) continue; // skip built-in people
        const keys = Object.keys(schema?.properties ?? {});
        const key = keys[0] ?? "Unknown";
        const results = JSON.parse(e.results);
        const val = results?.[key];
        groups.push({
          id: e._id,
          title: key.replace(/_/g, " "),
          items: Array.isArray(val) ? val : [],
        });
      } catch {
        // ignore
      }
    }
    return groups;
  }, [extractions, people]);

  // Precompute mention counts per entity item across all groups
  const mentionData = useMemo(() => {
    if (!blocks) return new Map<string, ReturnType<typeof findPersonMentions>>();
    const map = new Map<string, ReturnType<typeof findPersonMentions>>();
    for (const group of entityGroups) {
      for (const item of group.items) {
        if (!map.has(item)) {
          map.set(item, findPersonMentions(blocks, item));
        }
      }
    }
    return map;
  }, [entityGroups, blocks]);

  // Sort each group's items by mention count descending
  const sortedEntityGroups = useMemo(() => {
    return entityGroups.map((group) => ({
      ...group,
      items: [...group.items].sort(
        (a, b) => (mentionData.get(b)?.length ?? 0) - (mentionData.get(a)?.length ?? 0)
      ),
    }));
  }, [entityGroups, mentionData]);

  // Cross-document entity lookup: lowercase name → { entityId, documentCount }
  const crossDocMap = useMemo(() => {
    const map = new Map<string, { entityId: Id<"entities">; documentCount: number }>();
    if (!documentEntities) return map;
    for (const e of documentEntities) {
      map.set(e.name.toLowerCase(), {
        entityId: e._id,
        documentCount: e.documentCount,
      });
    }
    return map;
  }, [documentEntities]);

  // Index research dossiers by entity name for quick lookup
  const researchByEntity = useMemo(() => {
    const map = new Map<string, Doc<"research">>();
    if (!researchDossiers) return map;
    for (const d of researchDossiers) {
      map.set(d.entityName, d);
    }
    return map;
  }, [researchDossiers]);

  // Which presets have already been extracted
  const extractedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!extractions) return keys;
    for (const e of extractions) {
      try {
        const schema = JSON.parse(e.schemaUsed);
        const schemaKeys = Object.keys(schema?.properties ?? {});
        for (const k of schemaKeys) keys.add(k);
      } catch { /* ignore */ }
    }
    return keys;
  }, [extractions]);

  if (document === undefined) {
    return (
      <div className="p-8">
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  if (document === null) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">Document not found.</p>
        <Link to="/">
          <Button variant="outline" className="mt-4">
            Back to Home
          </Button>
        </Link>
      </div>
    );
  }

  async function handleCustomExtract() {
    const title = customTitle.trim();
    const desc = customDescription.trim();
    if (!title) return;

    const key = title.toLowerCase().replace(/\s+/g, "_");
    const schema = JSON.stringify({
      type: "object",
      properties: {
        [key]: {
          type: "array",
          items: { type: "string" },
          ...(desc ? { description: desc } : {}),
        },
      },
      required: [key],
    });

    setCustomExtracting(true);
    try {
      await runExtraction({ documentId, pageSchema: schema });
      setCustomTitle("");
      setCustomDescription("");
    } catch (err) {
      console.error("Custom extraction failed:", err);
    } finally {
      setCustomExtracting(false);
    }
  }

  const PRESET_ENTITIES = [
    { key: "places", label: "Places", description: "Geographic locations, cities, countries, addresses, and named places" },
    { key: "dates", label: "Dates", description: "Specific dates, date ranges, and time references" },
    { key: "telephone_numbers", label: "Phone Numbers", description: "Telephone numbers, fax numbers, and phone contacts" },
    { key: "emails", label: "Emails", description: "Email addresses" },
  ];

  async function handlePresetExtract(key: string, description: string) {
    const schema = JSON.stringify({
      type: "object",
      properties: {
        [key]: {
          type: "array",
          items: { type: "string" },
          description,
        },
      },
      required: [key],
    });

    setPresetExtracting((prev) => new Set(prev).add(key));
    try {
      await runExtraction({ documentId, pageSchema: schema });
    } catch (err) {
      console.error(`Preset extraction (${key}) failed:`, err);
    } finally {
      setPresetExtracting((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function handleResearch(entityName: string) {
    // Gather some document context from nearby mentions
    const mentions = mentionData.get(entityName) ?? [];
    const contextSnippets = mentions
      .slice(0, 3)
      .map((m) => m.snippet)
      .join(" … ");

    setResearching((prev) => new Set(prev).add(entityName));
    try {
      await runResearch({
        documentId,
        entityName,
        documentContext: contextSnippets || undefined,
      });
    } catch (err) {
      console.error(`Research failed for ${entityName}:`, err);
    } finally {
      setResearching((prev) => {
        const next = new Set(prev);
        next.delete(entityName);
        return next;
      });
    }
  }

  const hasBlocks = blocks && blocks.some((b) => b.bbox);
  const isParsed =
    document.status === "parsed" ||
    document.status === "completed" ||
    document.status === "extracting";

  // Build the overlay render function
  const activeSearch = searchQuery.trim().length >= 2 ? searchQuery.trim() : null;
  const overlayTerm = activeSearch;

  const renderOverlay =
    (showBlocks || overlayTerm) && blocks && pages
      ? (pageNumber: number) => (
          <>
            {showBlocks && (
              <BlockOverlay
                blocks={blocks}
                pages={pages}
                pageNumber={pageNumber}
                renderedWidth={700}
              />
            )}
            {overlayTerm && (
              <PersonHighlight
                blocks={blocks}
                pages={pages}
                personName={overlayTerm}
                pageNumber={pageNumber}
                renderedWidth={700}
              />
            )}
          </>
        )
      : undefined;

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b px-6 py-3 flex items-center gap-4 shrink-0">
        <Link to="/">
          <Button variant="ghost" size="sm">
            &larr; Back
          </Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold truncate">{document.name}</h1>
        </div>

        <div className="flex items-center gap-2">
          {hasBlocks && (
            <Button
              variant={showBlocks ? "default" : "outline"}
              size="sm"
              onClick={() => setShowBlocks((v) => !v)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                className="mr-1.5"
              >
                <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" strokeDasharray={showBlocks ? undefined : "2 1.5"} />
                <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" strokeDasharray={showBlocks ? undefined : "2 1.5"} />
                <rect x="1" y="9" width="14" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" strokeDasharray={showBlocks ? undefined : "2 1.5"} />
              </svg>
              Blocks
            </Button>
          )}

        </div>
      </header>

      <div className="flex-1 overflow-hidden" ref={viewerContainerRef}>
        <ViewerLayout
          toc={
            <TableOfContents
              blocks={blocks ?? []}
              currentPage={currentPage}
              totalPages={document.pageCount ?? 0}
              onNavigate={scrollToPage}
              searchQuery={searchQuery}
              onSearchChange={(q) => {
                setSearchQuery(q);
                // Clear entity selection if user manually clears or edits the search
                if (q !== selectedItem) setSelectedItem(null);
              }}
              isEntitySearch={!!selectedItem}
            />
          }
          viewer={
            url ? (
              <PdfViewer
                url={url}
                highlightText={overlayTerm ?? undefined}
                onVisiblePageChange={handleVisiblePageChange}
                renderOverlay={renderOverlay}
              />
            ) : (
              <div className="flex items-center justify-center h-96">
                <p className="text-muted-foreground">Loading PDF...</p>
              </div>
            )
          }
          sidebar={
            <Tabs defaultValue="entities" className="h-full">
              <TabsList className="w-full">
                <TabsTrigger value="entities">Entities</TabsTrigger>
                <TabsTrigger value="notes">Notes</TabsTrigger>
                <TabsTrigger value="info">Info</TabsTrigger>
              </TabsList>
              <TabsContent value="entities">
            <div className="flex flex-col gap-4">
              {/* New Entity */}
              {isParsed && (
                <div className="flex flex-col gap-3">
                  <h3 className="text-sm font-medium">New Entity</h3>

                  {/* Preset buttons */}
                  {PRESET_ENTITIES.some((p) => !extractedKeys.has(p.key)) && (
                    <div className="flex flex-wrap gap-1.5">
                      {PRESET_ENTITIES.filter((p) => !extractedKeys.has(p.key)).map((preset) => {
                        const isRunning = presetExtracting.has(preset.key);
                        return (
                          <button
                            key={preset.key}
                            onClick={() => handlePresetExtract(preset.key, preset.description)}
                            disabled={isRunning || document.status === "extracting"}
                            className={cn(
                              "text-xs px-2 py-1 rounded-md border transition-colors",
                              isRunning
                                ? "bg-muted text-muted-foreground cursor-wait"
                                : "bg-background hover:bg-accent text-foreground"
                            )}
                          >
                            {isRunning ? (
                              <span className="flex items-center gap-1">
                                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                {preset.label}
                              </span>
                            ) : (
                              <span className="flex items-center gap-1">
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                                  <path d="M5 1v8M1 5h8" />
                                </svg>
                                {preset.label}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Custom extraction form */}
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Custom
                  </h4>
                  <div className="flex flex-col gap-2">
                    <Input
                      placeholder="Title (e.g. Organizations)"
                      value={customTitle}
                      onChange={(e) => setCustomTitle(e.target.value)}
                      className="text-xs h-8"
                    />
                    <Input
                      placeholder="Description (e.g. Company names mentioned)"
                      value={customDescription}
                      onChange={(e) => setCustomDescription(e.target.value)}
                      className="text-xs h-8"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleCustomExtract}
                      disabled={
                        !customTitle.trim() ||
                        customExtracting ||
                        document.status === "extracting"
                      }
                      className="w-full"
                    >
                      {customExtracting ? "Extracting..." : "Extract"}
                    </Button>
                  </div>
                </div>
              )}

              <ProcessingStatus documentId={documentId} />

              {/* Entity groups */}
              {sortedEntityGroups.map((group) => {
                const isGroupCollapsed = collapsedGroups.has(group.id);
                const toggleGroup = () =>
                  setCollapsedGroups((prev) => {
                    const next = new Set(prev);
                    next.has(group.id) ? next.delete(group.id) : next.add(group.id);
                    return next;
                  });

                return (
                <div key={group.id}>
                  <button
                    onClick={toggleGroup}
                    className="w-full flex items-center gap-1.5 mb-2 group/group"
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className={cn(
                        "shrink-0 text-muted-foreground transition-transform",
                        !isGroupCollapsed && "rotate-90"
                      )}
                    >
                      <path d="M3 1l4 4-4 4" />
                    </svg>
                    <h3 className="text-sm font-medium capitalize group-hover/group:text-foreground text-left">
                      {group.title}
                    </h3>
                    {group.items.length > 0 && (
                      <span className="text-xs text-muted-foreground font-normal tabular-nums">
                        {group.items.length}
                      </span>
                    )}
                  </button>

                  {!isGroupCollapsed && group.items.length > 0 ? (
                    <div className="flex flex-col">
                      {group.items.map((item) => {
                        const mentions = mentionData.get(item) ?? [];
                        const isActive = selectedItem === item;
                        const dossier = researchByEntity.get(item);
                        const isResearching = researching.has(item);
                        const crossDoc = crossDocMap.get(item.toLowerCase());

                        return (
                          <div key={item} className="border-b border-border/50 last:border-0">
                            <div className="flex items-center">
                              <button
                                onClick={() => {
                                  if (isActive) {
                                    setSelectedItem(null);
                                    setSearchQuery("");
                                  } else {
                                    setSelectedItem(item);
                                    setSearchQuery(item);
                                  }
                                }}
                                className={cn(
                                  "flex-1 text-left px-2 py-1.5 flex items-center gap-1.5 text-[13px] transition-colors",
                                  isActive
                                    ? "bg-purple-50 font-semibold text-purple-900"
                                    : "hover:bg-accent"
                                )}
                              >
                                <span className="flex-1 truncate">{item}</span>
                                <span
                                  className={cn(
                                    "text-xs tabular-nums shrink-0",
                                    isActive ? "text-purple-600 font-semibold" : "text-muted-foreground"
                                  )}
                                >
                                  {mentions.length}
                                </span>
                              </button>
                              {/* Research button inline */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleResearch(item);
                                }}
                                disabled={isResearching || dossier?.status === "pending"}
                                className={cn(
                                  "shrink-0 px-1.5 py-1.5 transition-colors",
                                  isResearching || dossier?.status === "pending"
                                    ? "text-muted-foreground/40"
                                    : dossier?.status === "completed"
                                      ? "text-purple-400 hover:text-purple-600"
                                      : "text-muted-foreground/40 hover:text-muted-foreground"
                                )}
                                title={dossier?.status === "completed" ? "Refresh dossier" : "Research this entity"}
                              >
                                {isResearching || dossier?.status === "pending" ? (
                                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                  </svg>
                                ) : (
                                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <circle cx="7" cy="7" r="5" />
                                    <path d="M11 11l3.5 3.5" />
                                  </svg>
                                )}
                              </button>
                            </div>

                            {/* Cross-document indicator */}
                            {crossDoc && crossDoc.documentCount > 1 && (
                              <CrossDocIndicator
                                entityId={crossDoc.entityId}
                                documentCount={crossDoc.documentCount}
                                currentDocId={documentId}
                                isActive={isActive}
                              />
                            )}

                            {/* Research dossier — show when active or completed */}
                            {dossier?.status === "failed" && isActive && (
                              <div className="px-2 pb-2">
                                <p className="text-xs text-red-500">
                                  Research failed: {dossier.errorMessage}
                                </p>
                              </div>
                            )}

                            {dossier?.status === "completed" && dossier.content && isActive && (
                              <div className="px-2 pb-2">
                                <ResearchDossier dossier={dossier} onRefresh={() => handleResearch(item)} />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : !isGroupCollapsed ? (
                    <p className="text-xs text-muted-foreground">
                      {group.id === "people" && (document.status === "extracting" || document.status === "parsing")
                        ? "Extracting..."
                        : "No results found."}
                    </p>
                  ) : null}
                </div>
                );
              })}

            </div>
              </TabsContent>
              <TabsContent value="notes">
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Notes for this document will appear here.
                  </p>
                </div>
              </TabsContent>
              <TabsContent value="info">
                <div className="flex flex-col gap-4">
                  {document && (
                    <div className="flex flex-col gap-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Name</span>
                        <span className="truncate ml-4 text-right">{document.name}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Pages</span>
                        <span>{document.pageCount ?? "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Status</span>
                        <span className="capitalize">{document.status}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Uploaded</span>
                        <span>{new Date(document.uploadedAt).toLocaleDateString()}</span>
                      </div>
                      {document.completedAt && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Completed</span>
                          <span>{new Date(document.completedAt).toLocaleDateString()}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Research dossier display component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structured dossier types
// ---------------------------------------------------------------------------

interface DossierData {
  bio: {
    full_name: string;
    occupation: string;
    title: string;
    organization: string;
    location: string;
  };
  contact: {
    email: string;
    phone: string;
    website?: string;
    social_profiles?: string[];
  };
  summary: string;
  key_facts: string[];
  recent_activity: string[];
  connections: { name: string; relationship: string }[];
}

// ---------------------------------------------------------------------------
// Research dossier display component (structured)
// ---------------------------------------------------------------------------

function ResearchDossier({
  dossier,
  onRefresh,
}: {
  dossier: Doc<"research">;
  onRefresh: () => void;
}) {
  // Parse structured content, fall back to null if it's old markdown format
  const data = useMemo<DossierData | null>(() => {
    try {
      let raw = dossier.content;
      // Handle double-stringified JSON
      if (raw.startsWith('"') && raw.endsWith('"')) {
        raw = JSON.parse(raw);
      }
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed?.bio && parsed?.summary) return parsed as DossierData;
      return null;
    } catch {
      return null;
    }
  }, [dossier.content]);

  // Build citation lookup for tooltips
  const citations = useMemo(() => {
    return dossier.citations.map((url) => {
      try {
        const parsed = new URL(url);
        return {
          url,
          domain: parsed.hostname.replace(/^www\./, ""),
          path:
            parsed.pathname.length > 1
              ? decodeURIComponent(parsed.pathname).slice(0, 60)
              : "",
        };
      } catch {
        return { url, domain: url.slice(0, 30), path: "" };
      }
    });
  }, [dossier.citations]);

  // Fallback: old markdown dossiers
  if (!data) {
    return (
      <div className="mt-1 text-xs leading-relaxed text-foreground whitespace-pre-wrap">
        {dossier.content}
        <div className="mt-1 flex justify-end">
          <RefreshButton onRefresh={onRefresh} />
        </div>
      </div>
    );
  }

  const isUnknown = (val: string | undefined) =>
    !val || val.toLowerCase() === "unknown";

  return (
    <div className="mt-1 space-y-2">
      {/* Summary */}
      <p className="text-xs leading-relaxed">{data.summary}</p>

      {/* Bio card */}
      <div className="rounded-md border bg-muted/30 px-2.5 py-2 space-y-1">
        <DossierField label="Name" value={data.bio.full_name} />
        <DossierField label="Title" value={data.bio.title} />
        <DossierField label="Org" value={data.bio.organization} />
        <DossierField label="Role" value={data.bio.occupation} />
        <DossierField label="Location" value={data.bio.location} />
      </div>

      {/* Contact */}
      {(!isUnknown(data.contact.email) ||
        !isUnknown(data.contact.phone) ||
        !isUnknown(data.contact.website) ||
        (data.contact.social_profiles && data.contact.social_profiles.length > 0)) && (
        <div className="rounded-md border bg-muted/30 px-2.5 py-2 space-y-1">
          {!isUnknown(data.contact.email) && (
            <DossierField label="Email" value={data.contact.email} isLink={data.contact.email.includes("@") ? `mailto:${data.contact.email}` : undefined} />
          )}
          {!isUnknown(data.contact.phone) && (
            <DossierField label="Phone" value={data.contact.phone} />
          )}
          {!isUnknown(data.contact.website) && data.contact.website && (
            <DossierField label="Web" value={data.contact.website} isLink={data.contact.website} />
          )}
          {data.contact.social_profiles && data.contact.social_profiles.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {data.contact.social_profiles.map((url, i) => {
                let label = "Link";
                try {
                  const host = new URL(url).hostname.replace(/^www\./, "");
                  if (host.includes("linkedin")) label = "LinkedIn";
                  else if (host.includes("twitter") || host.includes("x.com")) label = "X";
                  else if (host.includes("github")) label = "GitHub";
                  else label = host.split(".")[0];
                } catch { /* use default */ }
                return (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {label}
                  </a>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Key Facts */}
      {data.key_facts.length > 0 && (
        <DossierSection title="Key Facts">
          <ul className="text-xs leading-relaxed pl-3.5 list-disc space-y-0.5">
            {data.key_facts.map((fact, i) => (
              <li key={i} className="text-muted-foreground">{fact}</li>
            ))}
          </ul>
        </DossierSection>
      )}

      {/* Recent Activity */}
      {data.recent_activity.length > 0 && (
        <DossierSection title="Recent Activity">
          <ul className="text-xs leading-relaxed pl-3.5 list-disc space-y-0.5">
            {data.recent_activity.map((item, i) => (
              <li key={i} className="text-muted-foreground">{item}</li>
            ))}
          </ul>
        </DossierSection>
      )}

      {/* Connections */}
      {data.connections.length > 0 && (
        <DossierSection title="Connections">
          <div className="space-y-1">
            {data.connections.map((conn, i) => (
              <div key={i} className="flex items-baseline gap-1.5 text-xs">
                <span className="font-medium text-foreground shrink-0">{conn.name}</span>
                <span className="text-muted-foreground">— {conn.relationship}</span>
              </div>
            ))}
          </div>
        </DossierSection>
      )}

      {/* Sources */}
      {citations.length > 0 && (
        <DossierSection title={`Sources (${citations.length})`}>
          <div className="flex flex-wrap gap-1">
            {citations.map((cite, i) => (
              <CitationChip key={i} num={i + 1} cite={cite} />
            ))}
          </div>
        </DossierSection>
      )}

      {/* Refresh */}
      <div className="flex justify-end">
        <RefreshButton onRefresh={onRefresh} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dossier sub-components
// ---------------------------------------------------------------------------

function DossierField({
  label,
  value,
  isLink,
}: {
  label: string;
  value: string;
  isLink?: string;
}) {
  if (!value || value.toLowerCase() === "unknown") return null;
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="text-muted-foreground shrink-0 w-12 text-right">{label}</span>
      {isLink ? (
        <a
          href={isLink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline truncate"
          onClick={(e) => e.stopPropagation()}
        >
          {value}
        </a>
      ) : (
        <span className="text-foreground truncate">{value}</span>
      )}
    </div>
  );
}

function DossierSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        {title}
      </h4>
      {children}
    </div>
  );
}

function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onRefresh();
      }}
      className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <path d="M2 8a6 6 0 0110.5-4M14 8a6 6 0 01-10.5 4" />
        <path d="M14 2v4h-4M2 14v-4h4" />
      </svg>
      Refresh
    </button>
  );
}

// ---------------------------------------------------------------------------
// Citation chip with hover tooltip
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cross-document indicator: shows which other documents an entity appears in
// ---------------------------------------------------------------------------

function CrossDocIndicator({
  entityId,
  documentCount,
  currentDocId,
  isActive,
}: {
  entityId: Id<"entities">;
  documentCount: number;
  currentDocId: Id<"documents">;
  isActive: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const otherDocs = useQuery(
    api.entities.documentsForEntity,
    expanded ? { entityId } : "skip"
  );

  const otherCount = documentCount - 1;

  return (
    <div className="px-2">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className={cn(
          "text-[11px] flex items-center gap-1 transition-colors",
          isActive ? "text-purple-500" : "text-muted-foreground hover:text-foreground"
        )}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="8" height="10" rx="1" />
          <rect x="6" y="1" width="8" height="10" rx="1" />
        </svg>
        in {documentCount} doc{documentCount !== 1 ? "s" : ""}
        <svg
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={cn(
            "transition-transform",
            expanded && "rotate-90"
          )}
        >
          <path d="M3 1l4 4-4 4" />
        </svg>
      </button>

      {expanded && otherDocs && (
        <div className="mt-0.5 mb-1 flex flex-col">
          {otherDocs
            .filter((d) => d._id !== currentDocId)
            .map((doc) => (
              <Link
                key={doc._id}
                to={`/documents/${doc._id}`}
                className="text-[11px] text-primary hover:underline truncate pl-4 py-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                {doc.name}
                <span className="text-muted-foreground ml-1">
                  ({doc.mentionCount})
                </span>
              </Link>
            ))}
          {otherDocs.filter((d) => d._id !== currentDocId).length === 0 && (
            <span className="text-[11px] text-muted-foreground pl-4 py-0.5">
              Only in this document
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function CitationChip({
  num,
  cite,
}: {
  num: number;
  cite: { url: string; domain: string; path: string };
}) {
  const [show, setShow] = useState(false);

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <a
        href={cite.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors no-underline"
        onClick={(e) => e.stopPropagation()}
      >
        {cite.domain}
      </a>
      {show && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50 pointer-events-none">
          <div className="bg-foreground text-background text-[11px] leading-tight rounded-md px-2.5 py-1.5 shadow-lg whitespace-nowrap max-w-[300px]">
            <div className="font-medium truncate">[{num}] {cite.domain}</div>
            {cite.path && (
              <div className="text-background/70 truncate">{cite.path}</div>
            )}
          </div>
          <div className="flex justify-center">
            <div className="w-2 h-2 bg-foreground rotate-45 -mt-1" />
          </div>
        </div>
      )}
    </span>
  );
}


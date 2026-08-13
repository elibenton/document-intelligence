import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useParams, useSearchParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { extractionKey } from "../../convex/extractionSchema";
import {
  ImagePdfViewer,
  type ImagePdfViewerRef,
  type PageImage,
} from "@/components/viewer/ImagePdfViewer";
import { ImageViewer } from "@/components/viewer/ImageViewer";
import { WebClipViewer } from "@/components/viewer/WebClipViewer";
import { CsvViewer } from "@/components/viewer/CsvViewer";
import { TranslatedDocumentView } from "@/components/viewer/TranslatedDocumentView";
import { RecordingView } from "@/components/recordings/RecordingView";
import { ExtractionSetup } from "@/components/documents/ExtractionSetup";
import { ViewerLayout } from "@/components/viewer/ViewerLayout";
import { TableOfContents } from "@/components/viewer/TableOfContents";
import { PageOverlays } from "@/components/viewer/PageOverlays";
import { findPersonMentions } from "@/components/viewer/personMentions";
import type { EntityHover } from "@/components/viewer/EntityHighlights";
import { PipelineProgress } from "@/components/documents/PipelineProgress";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { DocumentIdentityMenu } from "@/components/documents/DocumentIdentityMenu";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { documentTitles } from "@/lib/documentTitle";
import { isCsvDocument } from "@/lib/uploadTypes";
import type { Id } from "../../convex/_generated/dataModel";

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const documentId = id as Id<"documents">;
  const navigate = useNavigate();
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
  const detections = useQuery(api.detections.byDocument, { documentId });
  const pageImages = useQuery(api.pageImages.byDocument, { documentId });
  const translatedPages = useQuery(api.translations.pagesByDocument, {
    documentId,
  });
  const ensureRendered = useMutation(api.pageImages.ensureRendered);
  const retryRender = useMutation(api.pageImages.retryRender);
  const retryTranslation = useMutation(api.translations.retry);
  const rotatePage = useMutation(api.pages.rotatePage);
  const rotateDocument = useMutation(api.documents.rotateDocument);

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
  const [showReextract, setShowReextract] = useState(false);
  const [languageView, setLanguageView] = useState<"translated" | "original">(
    "translated"
  );
  const [hoveredEntity, setHoveredEntity] = useState<EntityHover | null>(null);
  const imageViewerRef = useRef<ImagePdfViewerRef | null>(null);

  const handleVisiblePageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  const scrollToPage = useCallback((page: number) => {
    imageViewerRef.current?.scrollToPage(page);
  }, []);

  // Deep link support (?page=N&highlight=text): arm the highlight search and
  // scroll to the page once the viewer has rendered it.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const highlight = searchParams.get("highlight");
    if (highlight) {
      setSearchQuery(highlight);
      setSelectedItem(highlight);
    }
    const page = Number(searchParams.get("page"));
    if (!page || page < 1) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const el = window.document.querySelector(
        `[data-page-number="${page}"]`
      );
      if (el) {
        el.scrollIntoView({ block: "start" });
        clearInterval(timer);
      } else if (tries > 40) {
        clearInterval(timer);
      }
    }, 250);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Documents uploaded before page pre-rendering existed have no images —
  // kick off a render for them on first view (the mutation is a no-op if
  // images already exist or a render is already scheduled).
  const isCsv = document ? isCsvDocument(document) : false;
  // Paged documents (PDF and DOCX) get server-rendered page images and the
  // page-image reader; everything else falls back to the text view.
  const isPdfDocument =
    !isCsv &&
    (document?.mediaType === "pdf" ||
      document?.mediaType === "docx" ||
      document?.mimeType === "application/pdf");
  const isRecording = Boolean(
    document &&
      (document.mediaType === "audio" ||
        document.mediaType === "video" ||
        document.mimeType.startsWith("audio/") ||
        document.mimeType.startsWith("video/"))
  );

  // Recordings navigate via the transcript, so the page/section Contents tab
  // only applies to paged documents.
  const showContentsTab = !isCsv && !(
    document?.mediaType === "audio" ||
    document?.mediaType === "video" ||
    document?.mimeType.startsWith("audio/") ||
    document?.mimeType.startsWith("video/")
  );
  useEffect(() => {
    if (isPdfDocument && pageImages) {
      void ensureRendered({ documentId });
    }
  }, [isPdfDocument, pageImages, ensureRendered, documentId]);

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

  // Every tagged entity name, deduped — the set the viewer makes hoverable.
  // Very short names are dropped: they match too much to be useful targets.
  const entityNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const group of entityGroups) {
      for (const item of group.items) {
        const name = item.trim();
        if (name.length < 3) continue;
        const key = name.toLowerCase();
        if (!seen.has(key)) seen.set(key, name);
      }
    }
    return [...seen.values()];
  }, [entityGroups]);

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

  // Analyze's per-document extraction suggestions. Ones the user has already
  // run are noise, so match on the same key the custom form derives and drop
  // a pill once its results exist. Declared above the loading early-return —
  // every hook on this page has to run on every render.
  const suggestedExtractions = useMemo(
    () =>
      (document?.suggestedExtractions ?? []).filter(
        (suggestion) => !extractedKeys.has(extractionKey(suggestion.label))
      ),
    [document?.suggestedExtractions, extractedKeys]
  );

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

  const titles = documentTitles(document);
  const hasBlocks = blocks && blocks.some((b) => b.bbox);
  const isParsed =
    document.status === "parsed" ||
    document.status === "completed" ||
    document.status === "extracting";
  const hasTranslatedContent =
    document.translationStatus === "complete" &&
    document.translationLanguageCode !== document.sourceLanguageCode &&
    (isRecording || Boolean(translatedPages?.length));
  const translationInProgress =
    document.translationStatus === "queued" ||
    document.translationStatus === "translating";

  // Build the overlay render function
  const activeSearch = searchQuery.trim().length >= 2 ? searchQuery.trim() : null;
  const overlayTerm = activeSearch;

  // Each rendered page fetches its own full blocks (with word-level boxes)
  // inside PageOverlays — the page-level `blocks` subscription stays light.
  const renderOverlay =
    (showBlocks || overlayTerm || entityNames.length > 0) && pages
      ? (pageNumber: number, renderedWidth = 700) => (
          <>
            <PageOverlays
              documentId={documentId}
              pageNumber={pageNumber}
              pages={pages}
              showBlocks={showBlocks}
              highlightTerm={overlayTerm ?? undefined}
              entityNames={entityNames}
              hoveredEntity={hoveredEntity}
              onHoverEntity={setHoveredEntity}
              renderedWidth={renderedWidth}
            />
            {showBlocks && detections && pageImages && (
              <VisualObjectOverlay
                pageNumber={pageNumber}
                detections={detections}
                pages={pages}
                pageImages={pageImages}
              />
            )}
          </>
        )
      : undefined;

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b px-6 py-3 flex items-center gap-4 shrink-0">
        <Link to={document.projectId ? `/p/${document.projectId}` : "/"}>
          <Button variant="ghost" size="sm">
            &larr; Back
          </Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold truncate flex items-center gap-1.5">
            <DocumentIdentityMenu document={document} />
            <span className="truncate">{titles.primary}</span>
          </h1>
          {/* Original upload name under the AI-written title, indented past
              the icon so it lines up with the title text above it. */}
          {titles.original && (
            <p className="text-xs text-muted-foreground truncate ml-5">
              {titles.original}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isPdfDocument && (
            <div className="inline-flex rounded-md border" aria-label="Rotate document">
              <button
                type="button"
                className="px-2 py-1.5 text-xs hover:bg-accent"
                title="Rotate every page clockwise"
                onClick={() =>
                  void rotateDocument({ id: documentId, degrees: 90 })
                }
              >
                ↻ All
              </button>
            </div>
          )}
          {translationInProgress && (
            <span className="text-xs text-muted-foreground">
              Translating…
            </span>
          )}
          {document.translationStatus === "failed" && (
            <Button
              variant="outline"
              size="sm"
              title={document.translationError}
              onClick={() => void retryTranslation({ documentId })}
            >
              Retry translation
            </Button>
          )}
          {hasTranslatedContent && (
            <div
              className="inline-flex rounded-md border bg-muted/30 p-0.5"
              aria-label="Document language view"
            >
              <button
                type="button"
                onClick={() => setLanguageView("translated")}
                className={cn(
                  "rounded px-2 py-1 text-xs transition-colors",
                  languageView === "translated"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Translated
              </button>
              <button
                type="button"
                onClick={() => setLanguageView("original")}
                className={cn(
                  "rounded px-2 py-1 text-xs transition-colors",
                  languageView === "original"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Original
              </button>
            </div>
          )}
          {/* Pages render in the browser, so text-geometry extraction never
              blocks the viewer. It only affects selectable text and overlays,
              which is what this reports. */}
          {isPdfDocument && document.renderStatus === "failed" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void retryRender({ documentId })}
              title={document.renderLastError ?? undefined}
            >
              Retry text layer
            </Button>
          )}
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

      <div className="flex-1 overflow-hidden">
        <ViewerLayout
          viewer={
            isRecording ? (
              <RecordingView
                document={document}
                url={url}
                showTranslation={
                  hasTranslatedContent && languageView === "translated"
                }
              />
            ) : hasTranslatedContent && languageView === "translated" ? (
              <TranslatedDocumentView pages={translatedPages ?? []} />
            ) : url ? (
              document.mediaType === "webScrape" ? (
                <WebClipViewer
                  url={url}
                  sourceUrl={document.sourceUrl}
                  clippedAt={document.uploadedAt}
                />
              ) : isCsv ? (
                <CsvViewer url={url} name={document.name} />
              ) : document.mediaType === "image" ? (
                <ImageViewer url={url} name={document.name} />
              ) : isPdfDocument ? (
                // Pre-rendered page images: no client-side PDF parsing, so
                // pages never come up blank and scanned docs behave the same
                // as born-digital ones.
                <ImagePdfViewer
                  ref={imageViewerRef}
                  documentId={documentId}
                  pdfUrl={url}
                  pageImages={pageImages ?? []}
                  pages={pages ?? []}
                  totalPages={document.pageCount ?? pageImages?.length ?? 1}
                  documentRotation={document.viewerRotation ?? 0}
                  onVisiblePageChange={handleVisiblePageChange}
                  onRotatePage={(pageNumber) =>
                    void rotatePage({
                      documentId,
                      pageNumber: pageNumber - 1,
                      degrees: 90,
                    })
                  }
                  renderOverlay={renderOverlay}
                />
              ) : null
            ) : (
              <div className="flex flex-col items-center justify-center h-96 gap-3">
                <Spinner className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Loading document…</p>
              </div>
            )
          }
          sidebar={
            <Tabs defaultValue="entities" className="h-full">
              <TabsList className="w-full">
                <TabsTrigger value="entities">Entities</TabsTrigger>
                <TabsTrigger value="notes">Notes</TabsTrigger>
                <TabsTrigger value="info">Info</TabsTrigger>
                {showContentsTab && (
                  <TabsTrigger value="contents">Contents</TabsTrigger>
                )}
              </TabsList>
              {showContentsTab && (
                <TabsContent value="contents">
                  {/* Full-bleed inside the padded sidebar so rows and their
                      hover state span the panel edge to edge */}
                  <div className="-mx-4 -mt-4">
                    <TableOfContents
                      blocks={blocks ?? []}
                      outline={document.tableOfContents}
                      currentPage={currentPage}
                      totalPages={document.pageCount ?? 0}
                      onNavigate={scrollToPage}
                      searchQuery={searchQuery}
                      onSearchChange={(q) => {
                        setSearchQuery(q);
                        // Clear entity selection if the user edits the search
                        if (q !== selectedItem) setSelectedItem(null);
                      }}
                      isEntitySearch={!!selectedItem}
                    />
                  </div>
                </TabsContent>
              )}
              <TabsContent value="entities">
            <div className="flex flex-col gap-4">
              <PipelineProgress document={document} />

              {/* Upload review: confirm the extraction template before running */}
              {(document.status === "parsed" || showReextract) && (
                <ExtractionSetup
                  document={document}
                  onDone={() => setShowReextract(false)}
                />
              )}
              {document.status === "completed" && !showReextract && (
                <button
                  onClick={() => setShowReextract(true)}
                  className="text-xs text-muted-foreground hover:text-foreground text-left"
                >
                  ↻ Re-run extraction with template…
                </button>
              )}

              {/* New Entity */}
              {isParsed && (
                <div className="flex flex-col gap-3">
                  <h3 className="text-sm font-medium">New Entity</h3>

                  {/* Analyze's per-document suggestions. Unlike the presets
                      below — which are the same four for every document —
                      these come from what this document actually contains, so
                      they load into the custom form for editing rather than
                      firing a fixed schema. */}
                  {suggestedExtractions.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Suggested
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {suggestedExtractions.map((suggestion) => (
                          <button
                            key={suggestion.label}
                            title={suggestion.rationale || suggestion.prompt}
                            onClick={() => {
                              setCustomTitle(suggestion.label);
                              setCustomDescription(suggestion.prompt);
                            }}
                            disabled={document.status === "extracting"}
                            className="text-xs px-2 py-1 rounded-md border border-dashed bg-background hover:bg-accent text-foreground transition-colors"
                          >
                            {suggestion.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

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

              {/* Entity groups */}
              {sortedEntityGroups.map((group) => {
                const isGroupCollapsed = collapsedGroups.has(group.id);
                const toggleGroup = () =>
                  setCollapsedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
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
                                    ? "bg-purple-50 font-semibold text-purple-900 dark:bg-purple-950/50 dark:text-purple-100"
                                    : "hover:bg-accent"
                                )}
                              >
                                <span className="flex-1 truncate">{item}</span>
                                <span
                                  className={cn(
                                    "text-xs tabular-nums shrink-0",
                                    isActive ? "text-purple-600 dark:text-purple-400 font-semibold" : "text-muted-foreground"
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
                                      ? "text-purple-400 hover:text-purple-600 dark:hover:text-purple-300"
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
                                <p className="text-xs text-red-500 dark:text-red-400">
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
                    <div className="flex items-center justify-between rounded-md border px-2.5 py-1.5">
                      <span className="text-xs text-muted-foreground">
                        {document.archivedAt !== undefined
                          ? `Archived ${new Date(document.archivedAt).toLocaleDateString()}`
                          : "Manage document"}
                      </span>
                      <DocumentActions
                        documentId={document._id}
                        documentName={document.name}
                        archived={document.archivedAt !== undefined}
                        onDeleted={() =>
                          navigate(
                            document.projectId
                              ? `/p/${document.projectId}`
                              : "/"
                          )
                        }
                      />
                    </div>
                  )}
                  {document && <DocumentMetaEditor document={document} />}
                  {detections && detections.length > 0 && (
                    <VisualEvidenceList
                      detections={detections}
                      onJumpToPage={(page) => {
                        const el = window.document.querySelector(
                          `[data-page-number="${page}"]`
                        );
                        el?.scrollIntoView({ block: "start" });
                      }}
                    />
                  )}
                  {document && (
                    <div className="flex flex-col gap-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Name</span>
                        <span className="truncate ml-4 text-right">{document.name}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Media</span>
                        <span className="capitalize">{document.mediaType ?? "pdf"}</span>
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
// Visual evidence: signatures, redactions, stamps, handwriting, photos, logos
// detected on document pages (approximate, model-estimated regions)
// ---------------------------------------------------------------------------

const DETECTION_ICONS: Record<string, string> = {
  signature: "✍️",
  redaction: "⬛",
  stamp_or_seal: "🔏",
  handwriting: "📝",
  photograph: "📷",
  logo: "🏷️",
};

function VisualEvidenceList({
  detections,
  onJumpToPage,
}: {
  detections: Doc<"detections">[];
  onJumpToPage: (pageNumber: number) => void; // 1-based
}) {
  const sorted = [...detections].sort(
    (a, b) => a.pageNumber - b.pageNumber || a.label.localeCompare(b.label)
  );
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Visual Evidence
        <span className="ml-1.5 normal-case font-normal">
          ({detections.length})
        </span>
      </h3>
      {sorted.map((d) => (
        <button
          key={d._id}
          onClick={() => onJumpToPage(d.pageNumber + 1)}
          className="flex items-start gap-2 text-left border rounded-md px-2.5 py-1.5 hover:bg-accent/50 transition-colors"
          title="Jump to page"
        >
          <span className="text-sm leading-5">
            {DETECTION_ICONS[d.label] ?? "🔎"}
          </span>
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2 text-sm">
              <span className="font-medium capitalize">
                {d.label.replace(/_/g, " ")}
              </span>
              <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                p. {d.pageNumber + 1}
              </span>
            </span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              {d.description}
            </span>
          </span>
        </button>
      ))}
      <p className="text-[10px] text-muted-foreground mt-0.5">
        Locations are approximate, detected by AI.
      </p>
    </div>
  );
}

/**
 * Visual objects emitted by the same Interfaze completion as OCR and metadata.
 * Their stored coordinates are normalized against the OCR geometry. Correct
 * the vertical ratio when that geometry represents a stacked visual asset,
 * then place the object over the actual rendered PDF page.
 */
function VisualObjectOverlay({
  pageNumber,
  detections,
  pages,
  pageImages,
}: {
  pageNumber: number; // 1-based
  detections: Doc<"detections">[];
  pages: Array<{ pageNumber: number; width?: number; height?: number }>;
  pageImages: PageImage[];
}) {
  const pageIndex = pageNumber - 1;
  const page = pages.find((candidate) => candidate.pageNumber === pageIndex);
  const image = pageImages.find(
    (candidate) => candidate.pageNumber === pageIndex
  );
  const expectedOcrHeight =
    page?.width && image?.width && image.height
      ? page.width * (image.height / image.width)
      : undefined;
  const yCorrection =
    page?.height && expectedOcrHeight ? page.height / expectedOcrHeight : 1;

  return detections
    .filter((detection) => detection.pageNumber === pageIndex && detection.bbox)
    .map((detection) => {
      const bbox = detection.bbox!;
      const top = Math.min(1, Math.max(0, bbox.y * yCorrection));
      const height = Math.min(
        1 - top,
        Math.max(0, bbox.height * yCorrection)
      );
      return (
        <div
          key={detection._id}
          className="absolute rounded-sm border-2 border-orange-500 bg-orange-400/15"
          style={{
            left: `${Math.max(0, bbox.x) * 100}%`,
            top: `${top * 100}%`,
            width: `${Math.min(1 - bbox.x, bbox.width) * 100}%`,
            height: `${height * 100}%`,
          }}
          title={detection.description}
        >
          <span className="absolute -top-5 left-0 rounded bg-orange-500 px-1 py-0.5 text-[9px] font-semibold leading-none text-white whitespace-nowrap">
            {detection.label.replace(/_/g, " ")}
          </span>
        </div>
      );
    });
}

// ---------------------------------------------------------------------------
// Document meta editor: kind + tags (human-owned) and extracted metadata
// ---------------------------------------------------------------------------

interface ExtractedMetadata {
  title?: string;
  summary?: string;
  date?: string;
  author?: string;
  language?: string;
  additional?: { key: string; value: string }[];
}

function DocumentMetaEditor({ document }: { document: Doc<"documents"> }) {
  const updateDocumentMeta = useMutation(api.metadata.updateDocumentMeta);
  const kinds = useQuery(api.kinds.list);
  const [kindDraft, setKindDraft] = useState<string | null>(null);
  const [tagsDraft, setTagsDraft] = useState<string | null>(null);

  const meta = useMemo<ExtractedMetadata | null>(() => {
    if (!document.metadata) return null;
    try {
      return JSON.parse(document.metadata) as ExtractedMetadata;
    } catch {
      return null;
    }
  }, [document.metadata]);

  const kind = kindDraft ?? document.primaryKind ?? "";
  const tags = tagsDraft ?? (document.tags ?? []).join(", ");
  const dirty =
    (kindDraft !== null && kindDraft !== (document.primaryKind ?? "")) ||
    (tagsDraft !== null && tagsDraft !== (document.tags ?? []).join(", "));

  async function save() {
    await updateDocumentMeta({
      documentId: document._id,
      ...(kindDraft !== null ? { primaryKind: kindDraft } : {}),
      ...(tagsDraft !== null
        ? {
            tags: tagsDraft
              .split(",")
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean),
          }
        : {}),
    });
    setKindDraft(null);
    setTagsDraft(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">
          Kind{" "}
          {document.kindSource === "ai" && (
            <span className="text-[10px] uppercase tracking-wide text-purple-500">
              ai guess
            </span>
          )}
        </label>
        <Input
          list="info-document-kinds"
          value={kind}
          placeholder="e.g. legal brief"
          onChange={(e) => setKindDraft(e.target.value.toLowerCase())}
          className="text-xs h-8"
        />
        <datalist id="info-document-kinds">
          {(kinds ?? []).map((k) => (
            <option key={k._id} value={k.name} />
          ))}
        </datalist>
      </div>

      {/* The hierarchy behind the flat kind above: "writ of mandate" is also a
          "legal document", and both are worth showing (and filtering on). */}
      {(document.documentTypes ?? []).length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">
            Document type
          </label>
          <div className="flex flex-wrap gap-1.5">
            {document.documentTypes!.map((type) => (
              <span
                key={type.path.join("/")}
                title={`${Math.round(type.confidence * 100)}% confidence`}
                className="text-xs px-2 py-0.5 rounded-md border bg-muted/40"
              >
                {type.path.join(" › ")}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">
          Tags (comma-separated)
        </label>
        <Input
          value={tags}
          placeholder="e.g. litigation, 2024"
          onChange={(e) => setTagsDraft(e.target.value)}
          className="text-xs h-8"
        />
      </div>

      {dirty && (
        <Button size="sm" variant="outline" onClick={save}>
          Save
        </Button>
      )}

      {meta && (
        <div className="flex flex-col gap-1.5 text-sm border-t pt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Extracted metadata
          </h4>
          {meta.summary && (
            <p className="text-xs text-muted-foreground">{meta.summary}</p>
          )}
          {[
            ["Title", meta.title],
            ["Date", meta.date],
            ["Author", meta.author],
            ["Language", meta.language],
            ...(meta.additional ?? []).map(
              (kv) => [kv.key, kv.value] as [string, string]
            ),
          ]
            .filter(
              ([, value]) =>
                value && value !== "Unknown" && String(value).trim()
            )
            .map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3 text-xs">
                <span className="text-muted-foreground capitalize shrink-0">
                  {label}
                </span>
                <span className="text-right truncate">{value}</span>
              </div>
            ))}
        </div>
      )}
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
                    className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 dark:bg-purple-950/50 dark:text-purple-300 dark:hover:bg-purple-900/50 transition-colors"
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

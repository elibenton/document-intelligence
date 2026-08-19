import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useSearchParams, Link, useNavigate } from "react-router";
import { Folder } from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import {
  PdfViewer,
  type PdfViewerRef,
} from "@/components/viewer/PdfViewer";
import { ImageViewer } from "@/components/viewer/ImageViewer";
import { WebClipViewer } from "@/components/viewer/WebClipViewer";
import { CsvViewer } from "@/components/viewer/CsvViewer";
import { TranslatedDocumentView } from "@/components/viewer/TranslatedDocumentView";
import {
  RecordingView,
  type RecordingViewRef,
} from "@/components/recordings/RecordingView";
import { ViewerLayout } from "@/components/viewer/ViewerLayout";
import { ContentsPanel } from "@/components/viewer/ContentsPanel";
import { NotesPanel } from "@/components/viewer/NotesPanel";
import { buildTocHeaders, sectionForPage } from "@/components/viewer/tocHeaders";
import { ZoomControl } from "@/components/viewer/ZoomControl";
import { HighlighterTool } from "@/components/viewer/HighlighterTool";
import type { AnnotationColor } from "@/components/viewer/annotationColors";
import { useViewerZoom } from "@/components/viewer/useViewerZoom";
import { FLOATING_SURFACE } from "@/components/viewer/surfaces";
import { PageOverlays } from "@/components/viewer/PageOverlays";
import { findPersonMentions } from "@/components/viewer/personMentions";
import type { EntityHover } from "@/components/viewer/EntityHighlights";
import { PipelineProgress } from "@/components/documents/PipelineProgress";
import { DocumentUsage } from "@/components/documents/DocumentUsage";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { DocumentIdentityMenu } from "@/components/documents/DocumentIdentityMenu";
import {
  EntityConnectionList,
  type DocumentConnection,
} from "@/components/documents/EntityConnectionList";
import { ENTITY_TYPE_LABELS, entityTypeKey } from "@/lib/views/entityProperties";
import { entitySlug } from "@/lib/entitySlug";
import { useProjectSlug } from "@/hooks/useProjectSlug";
import { DocTypePills } from "@/components/documents/DocTypePills";
import { ProjectSearchDialog } from "@/components/search/ProjectSearchDialog";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { isAudioVideo } from "@/components/documents/docStatus";
import { documentTitles } from "@/lib/documentTitle";
import { isCsvDocument } from "@/lib/uploadTypes";
import type { Id } from "../../convex/_generated/dataModel";
import { isTypingTarget } from "@/lib/isTypingTarget";

/**
 * `id` arrives as a prop rather than from `useParams` because the route module
 * is DocumentRoute, which owns the typed params — so a rename of `:id` in
 * routes.ts is a type error here rather than an undefined at runtime.
 */
export default function DocumentPage({ id }: { id: string }) {
  const documentId = id as Id<"documents">;
  const navigate = useNavigate();
  const document = useQuery(api.documents.get, { id: documentId });
  const projectSlug = useProjectSlug(document?.projectId);
  const url = document?.url ?? undefined;
  const blocks = useQuery(api.blocks.byDocument, { documentId });
  const pages = useQuery(api.pages.byDocument, { documentId });
  const addEntityType = useMutation(api.projectEntityTypes.create);
  const documentEntities = useQuery(api.entities.byDocument, { documentId });
  const projectEntityTypes = useQuery(
    api.projectEntityTypes.list,
    document?.projectId ? { projectId: document.projectId } : "skip"
  );
  const documentConnections = useQuery(api.relationships.byDocument, {
    documentId,
  });
  const detections = useQuery(api.detections.byDocument, { documentId });
  const translatedPages = useQuery(api.translations.pagesByDocument, {
    documentId,
  });
  const retryTranslation = useMutation(api.translations.retry);
  const rotateDocument = useMutation(api.documents.rotateDocument);

  const [currentPage, setCurrentPage] = useState(1);
  const [showBlocks, setShowBlocks] = useState(false);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  /** Entity names whose connections are showing beneath them. */
  const [expandedEntities, setExpandedEntities] = useState<Set<string>>(
    new Set()
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [customTitle, setCustomTitle] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customExtracting, setCustomExtracting] = useState(false);
  const [showNewEntityForm, setShowNewEntityForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Bumped by ⌘F/Ctrl+F. Opens the contents panel if it was minimized and
  // focuses its search box — the document's own find, in place of the
  // browser's, which can only see the page that happens to be on screen.
  const [findSignal, setFindSignal] = useState(0);
  const [languageView, setLanguageView] = useState<"translated" | "original">(
    "translated"
  );
  const [hoveredEntity, setHoveredEntity] = useState<EntityHover | null>(null);
  // Which highlight has its comment box open. Lives here because both the page
  // and the notes list drive it — clicking a note opens the box on the page.
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null
  );
  // The armed highlighter color, or null when the pen is away. Lives here
  // because the tool floats in the layout while the commit happens inside
  // whichever viewer (PDF or transcript) is mounted.
  const [penColor, setPenColor] = useState<AnnotationColor | null>(null);
  // How much room the layout gave the viewer, and the zoom floor that keeps
  // the page from shrinking before the panels do (see panelLayout).
  const [viewerMetrics, setViewerMetrics] = useState({ width: 0, zoomFloor: 1 });
  const handleViewerMetrics = useCallback(
    (width: number, zoomFloor: number) =>
      setViewerMetrics((prev) =>
        prev.width === width && prev.zoomFloor === zoomFloor
          ? prev
          : { width, zoomFloor }
      ),
    []
  );
  const { zoom, chooseZoom, fitToWidth } = useViewerZoom(
    viewerMetrics.width,
    viewerMetrics.zoomFloor
  );
  const viewerRef = useRef<PdfViewerRef | null>(null);
  const recordingRef = useRef<RecordingViewRef | null>(null);

  const handleVisiblePageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  const scrollToPage = useCallback((page: number) => {
    viewerRef.current?.scrollToPage(page);
  }, []);

  // The same section list the Contents panel shows, so a new note is filed
  // under exactly the heading the user can see it sitting beneath.
  const tocHeaders = useMemo(
    () => buildTocHeaders(blocks ?? [], document?.tableOfContents),
    [blocks, document?.tableOfContents]
  );
  const sectionTitleForPage = useCallback(
    (pageNumber: number) => sectionForPage(tocHeaders, pageNumber)?.text,
    [tocHeaders]
  );

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

  // Documents from before the geometry pass have no page text geometry —
  // kick off a render for them on first view (the mutation is a no-op when
  // the geometry is current or a render is already scheduled).
  const isCsv = document ? isCsvDocument(document) : false;
  // Paged documents (PDF and DOCX) get the paged reader — pages drawn
  // client-side by pdf.js over the stored text geometry; everything else
  // falls back to a media-specific view.
  const isPdfDocument =
    !isCsv &&
    (document?.mediaType === "pdf" ||
      document?.mimeType === "application/pdf");
  /**
   * How many pages the viewer lays out.
   *
   * `document.pageCount` is written by the parse pass, so a document whose
   * parse failed carries none — and the viewer was then drawing exactly one
   * page of a 20-page PDF while the file itself was fine. Fall through to the
   * committed `pages` rows; the client's own pdf.js load supplies the truth
   * once the file opens either way.
   */
  const totalPages = document?.pageCount ?? (pages?.length || undefined);
  const isRecording = Boolean(document && isAudioVideo(document));

  // Recordings navigate via the transcript, so the page/section Contents tab
  // only applies to paged documents.
  const showContentsTab = !isCsv && !isRecording;
  useEffect(() => {
    if (!showContentsTab) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "f" || e.altKey || !(e.metaKey || e.ctrlKey)) return;
      // Overriding browser find is only defensible outside a text field.
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setFindSignal((n) => n + 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showContentsTab]);

  /**
   * The sidebar's entity groups, read from the entities table.
   *
   * This used to parse `extractions` JSON and group by whichever schema key
   * produced each list — so the panel showed headings like "Parties", "Dates"
   * and "Key Terms", varying document to document, with a person and a date
   * rendered as the same kind of thing. The entity rows carry a real type, and
   * one pass now writes them (convex/relationshipsNode.ts), so the grouping is
   * the type: People, then Organizations, then anything a project declared.
   */
  const entityGroups = useMemo(() => {
    if (!documentEntities) return [];
    const byType = new Map<string, string[]>();
    for (const entity of documentEntities) {
      const key = entityTypeKey(entity.type);
      const names = byType.get(key);
      if (names) names.push(entity.name);
      else byType.set(key, [entity.name]);
    }
    // Known types in their declared order, then project types alphabetically —
    // so People and Organizations never move around beneath the reader.
    const known = Object.keys(ENTITY_TYPE_LABELS).filter((key) =>
      byType.has(key)
    );
    const extra = [...byType.keys()]
      .filter((key) => !(key in ENTITY_TYPE_LABELS))
      .sort();
    // A project-declared type carries its own label ("Vessels"); the raw key
    // is only ever shown if the type was deleted while its entities remain.
    const declared = new Map(
      (projectEntityTypes ?? []).map((t) => [t.key, t.label])
    );
    return [...known, ...extra].map((key) => ({
      id: key,
      title: ENTITY_TYPE_LABELS[key] ?? declared.get(key) ?? key,
      items: byType.get(key) ?? [],
    }));
  }, [documentEntities, projectEntityTypes]);

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

  // Connections filed under the entity they belong to, so the sidebar can show
  // what a document says about a person directly beneath their name. A
  // connection lands under both of its endpoints — read from each one's side.
  const connectionsByEntity = useMemo(() => {
    const map = new Map<Id<"entities">, DocumentConnection[]>();
    for (const connection of documentConnections?.connections ?? []) {
      for (const end of [connection.source, connection.target]) {
        const existing = map.get(end._id);
        if (existing) existing.push(connection);
        else map.set(end._id, [connection]);
      }
    }
    return map;
  }, [documentConnections]);

  /** lowercase name → the role this entity plays in this document. */
  const roleByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const entity of documentEntities ?? []) {
      if (entity.role) map.set(entity.name.toLowerCase(), entity.role);
    }
    return map;
  }, [documentEntities]);

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

  /**
   * Declare a type this project should look for from now on.
   *
   * This used to run a one-off extraction against this document alone, whose
   * results became entities typed by the JSON key the form generated — which is
   * where "dates" and "parties" entities came from. A declared type instead
   * joins the graph pass's enum for every document read afterwards.
   */
  async function handleAddEntityType() {
    if (!document?.projectId || !customTitle.trim() || !customDescription.trim()) {
      return;
    }
    setCustomExtracting(true);
    try {
      await addEntityType({
        projectId: document.projectId,
        label: customTitle.trim(),
        description: customDescription.trim(),
      });
      setCustomTitle("");
      setCustomDescription("");
      setShowNewEntityForm(false);
    } catch (err) {
      console.error("Adding entity type failed:", err);
    } finally {
      setCustomExtracting(false);
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
            {showBlocks && detections && (
              <VisualObjectOverlay
                pageNumber={pageNumber}
                detections={detections}
              />
            )}
          </>
        )
      : undefined;

  return (
    // Everything on this page floats above the canvas: the chrome is a row of
    // separate cards rather than a header bar, so the document reads as the
    // thing on the desk and the panels as what is laid over it.
    <div className="flex h-screen flex-col gap-2 bg-viewer-canvas p-2">
      {document.projectId && (
        <ProjectSearchDialog projectId={document.projectId} />
      )}
      {/* Every item in this row shares one height (h-14) so the row reads as
          a single strip — the back button and toolbar chips stretch to match
          the title card via items-stretch, rather than each picking its own
          size. */}
      <header className="flex h-14 shrink-0 items-stretch gap-2">
        <Link
          to={projectSlug ? `/p/${projectSlug}` : "/"}
          title="Back to project"
          aria-label="Back to project"
          className={cn(
            FLOATING_SURFACE,
            "flex w-14 items-center justify-center text-foreground transition-colors hover:bg-accent"
          )}
        >
          <Folder className="size-4" />
        </Link>
        <div
          className={cn(
            FLOATING_SURFACE,
            "group/title flex min-w-0 flex-1 items-center gap-3 px-4"
          )}
        >
          {/* Renaming and re-typing the document lives behind the ⋮ menu next
              to the type pills — the title itself is just a title. The menu
              stays out of sight until you're over the title, so the type
              pills aren't fighting a third element for room at rest. */}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold leading-tight text-foreground">
              {titles.primary}
            </h1>
            {titles.original && (
              <p className="truncate text-xs text-foreground">
                {titles.original}
              </p>
            )}
          </div>
          <DocTypePills
            projectId={document.projectId}
            primaryCategory={document.primaryCategory}
            primaryKind={document.primaryKind}
            className="shrink-0"
          />
          <DocumentIdentityMenu
            document={document}
            className="shrink-0 opacity-0 transition-opacity group-hover/title:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
          />
        </div>

        <div className="flex items-stretch gap-2">
          {translationInProgress && (
            <span
              className={cn(
                FLOATING_SURFACE,
                "flex items-center px-3 text-xs text-foreground"
              )}
            >
              Translating…
            </span>
          )}
          {document.translationStatus === "failed" && (
            <Button
              variant="outline"
              size="sm"
              className="h-full shadow-md"
              title={document.translationError}
              onClick={() => void retryTranslation({ documentId })}
            >
              Retry translation
            </Button>
          )}
          {hasTranslatedContent && (
            <div
              className={cn(FLOATING_SURFACE, "flex items-center p-0.5")}
              aria-label="Document language view"
            >
              <button
                type="button"
                onClick={() => setLanguageView("translated")}
                className={cn(
                  "flex h-full items-center rounded px-3 text-xs text-foreground transition-colors",
                  languageView === "translated"
                    ? "bg-background shadow-sm"
                    : "hover:bg-accent"
                )}
              >
                Translated
              </button>
              <button
                type="button"
                onClick={() => setLanguageView("original")}
                className={cn(
                  "flex h-full items-center rounded px-3 text-xs text-foreground transition-colors",
                  languageView === "original"
                    ? "bg-background shadow-sm"
                    : "hover:bg-accent"
                )}
              >
                Original
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ViewerLayout
          leftLabel="Contents"
          sidebarLabel="Details"
          onViewerMetrics={handleViewerMetrics}
          revealLeft={findSignal}
          left={
            showContentsTab ? (
              <div className={cn(FLOATING_SURFACE, "h-full overflow-hidden")}>
              <ContentsPanel
                blocks={blocks ?? []}
                outline={document.tableOfContents}
                currentPage={currentPage}
                totalPages={totalPages ?? 0}
                onNavigate={scrollToPage}
                searchQuery={searchQuery}
                onSearchChange={(q) => {
                  setSearchQuery(q);
                  // Clear entity selection if the user edits the search
                  if (q !== selectedItem) setSelectedItem(null);
                }}
                isEntitySearch={!!selectedItem}
                focusSignal={findSignal}
              />
              </div>
            ) : undefined
          }
          bottomLeft={
            isPdfDocument || isRecording ? (
              <div className="flex flex-col items-start gap-2">
                <HighlighterTool color={penColor} onChange={setPenColor} />
                {isPdfDocument && (
                  <ZoomControl
                    zoom={zoom}
                    onZoomChange={chooseZoom}
                    onFitWidth={fitToWidth}
                    currentPage={currentPage}
                    totalPages={totalPages ?? 0}
                  />
                )}
              </div>
            ) : undefined
          }
          bottomRight={
            <PipelineProgress document={document} floating collapseWhenDone />
          }
          viewer={
            isRecording ? (
              <RecordingView
                ref={recordingRef}
                document={document}
                url={url}
                showTranslation={
                  hasTranslatedContent && languageView === "translated"
                }
                penColor={penColor}
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
                // Pages drawn client-side by pdf.js from the original file;
                // the stored geometry supplies the selectable text layer, so
                // scanned docs behave the same as born-digital ones.
                <PdfViewer
                  ref={viewerRef}
                  documentId={documentId}
                  pdfUrl={url}
                  pages={pages ?? []}
                  totalPages={totalPages ?? 1}
                  zoom={zoom}
                  documentRotation={document.viewerRotation ?? 0}
                  onVisiblePageChange={handleVisiblePageChange}
                  renderOverlay={renderOverlay}
                  sectionTitleForPage={sectionTitleForPage}
                  activeAnnotationId={activeAnnotationId}
                  onActiveAnnotationChange={setActiveAnnotationId}
                  penColor={penColor}
                />
              ) : null
            ) : (
              <div className="flex flex-col items-center justify-center h-96 gap-3">
                <Spinner className="size-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Loading document…</p>
              </div>
            )
          }
          sidebar={
            <div className="flex h-full flex-col overflow-hidden">
              {/* The description is the only thing pinned above the tabs now —
                  identity (name, kind) moved to the title bar's pill + ⋮ menu,
                  and tags/extracted-metadata detail moved into the Info tab.
                  DocumentSummary owns its own border/padding and renders
                  nothing at all once there's no summary to show. */}
              <DocumentSummary document={document} />

              <Tabs
                defaultValue="entities"
                className="flex min-h-0 flex-1 flex-col gap-0"
              >
                <div className="shrink-0 px-4 pt-3">
                  <TabsList className="w-full">
                    <TabsTrigger value="entities">Entities</TabsTrigger>
                    <TabsTrigger value="notes">Notes</TabsTrigger>
                    <TabsTrigger value="info">Info</TabsTrigger>
                  </TabsList>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <TabsContent value="entities">
            <div className="flex flex-col gap-4">
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
                        const isActive = selectedItem === item;
                        const crossDoc = crossDocMap.get(item.toLowerCase());
                        const role = roleByName.get(item.toLowerCase());
                        const connections = crossDoc
                          ? connectionsByEntity.get(crossDoc.entityId) ?? []
                          : [];
                        const isExpanded = expandedEntities.has(item);

                        return (
                          <div key={item} className="border-b border-border/50 last:border-0">
                            <div className="flex items-center">
                              {/* Connections live under the name they belong
                                  to rather than in a tab of their own: the
                                  reader is already looking at the person they
                                  care about, and a separate list made them
                                  find that person again in every row. */}
                              <button
                                onClick={() =>
                                  setExpandedEntities((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(item)) next.delete(item);
                                    else next.add(item);
                                    return next;
                                  })
                                }
                                disabled={connections.length === 0}
                                title={
                                  connections.length === 0
                                    ? "No connections in this document"
                                    : `${connections.length} connection${connections.length === 1 ? "" : "s"}`
                                }
                                className="shrink-0 pl-1 pr-0.5 py-1.5 disabled:opacity-25"
                              >
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 10 10"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  className={cn(
                                    "text-muted-foreground transition-transform",
                                    isExpanded && "rotate-90"
                                  )}
                                >
                                  <path d="M3 1l4 4-4 4" />
                                </svg>
                              </button>
                              {/* The row highlights the entity in the document;
                                  the name itself goes to the entity's page.
                                  A div rather than a button because a link
                                  cannot legally nest inside one, and the name
                                  is the thing a reader reaches for. */}
                              <div
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                  if (isActive) {
                                    setSelectedItem(null);
                                    setSearchQuery("");
                                  } else {
                                    setSelectedItem(item);
                                    setSearchQuery(item);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter" && e.key !== " ") return;
                                  e.preventDefault();
                                  setSelectedItem(isActive ? null : item);
                                  setSearchQuery(isActive ? "" : item);
                                }}
                                title={
                                  isActive
                                    ? "Clear highlight"
                                    : `Highlight ${item} in the document`
                                }
                                className={cn(
                                  "flex flex-1 cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left text-sm transition-colors",
                                  isActive
                                    ? "bg-purple-50 font-semibold text-purple-900 dark:bg-purple-950/50 dark:text-purple-100"
                                    : "hover:bg-accent"
                                )}
                              >
                                <Link
                                  to={`/entity/${entitySlug(item)}${
                                    document.projectId
                                      ? `?project=${document.projectId}`
                                      : ""
                                  }`}
                                  onClick={(e) => e.stopPropagation()}
                                  title={`Open ${item}`}
                                  className="min-w-0 flex-1 truncate hover:underline"
                                >
                                  {item}
                                </Link>
                                {/* What this entity is to this document, held
                                    to the right edge so the roles line up as
                                    their own column rather than trailing each
                                    name at a different offset. */}
                                {role && (
                                  <span
                                    className={cn(
                                      "shrink-0 rounded-full px-1.5 py-0.5 text-2xs capitalize leading-none",
                                      isActive
                                        ? "bg-purple-200/70 text-purple-900 dark:bg-purple-800/60 dark:text-purple-100"
                                        : "bg-muted text-muted-foreground"
                                    )}
                                  >
                                    {role}
                                  </span>
                                )}
                              </div>
                            </div>

                            {isExpanded && crossDoc && (
                              <div className="pb-1.5 pl-5 pr-2">
                                <EntityConnectionList
                                  connections={connections}
                                  subjectId={crossDoc.entityId}
                                  documentId={documentId}
                                  projectId={document.projectId ?? null}
                                  onLocate={(text, isEntity, pageNumber) => {
                                    setSelectedItem(isEntity ? text : null);
                                    setSearchQuery(text);
                                    if (pageNumber !== undefined) {
                                      scrollToPage(pageNumber + 1);
                                    }
                                  }}
                                />
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

              {/* New Entity: a single button at the bottom of the list, not a
                  form competing with the entities themselves for attention. */}
              {isParsed && (
                <div className="border-t pt-3">
                  {showNewEntityForm ? (
                    <div className="flex flex-col gap-2">
                      <Input
                        placeholder="Name (e.g. Vessels)"
                        value={customTitle}
                        onChange={(e) => setCustomTitle(e.target.value)}
                        autoFocus
                        className="text-xs h-8"
                      />
                      <Input
                        placeholder="What counts as one (e.g. a named ship or barge)"
                        value={customDescription}
                        onChange={(e) => setCustomDescription(e.target.value)}
                        className="text-xs h-8"
                      />
                      {/* Says plainly that this is forward-looking. The old
                          form ran against this document immediately, so the
                          button meaning something different now matters. */}
                      <p className="text-2xs leading-snug text-muted-foreground">
                        Applies to documents uploaded from now on. Re-run this
                        document to apply it here.
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleAddEntityType}
                          disabled={
                            !customTitle.trim() ||
                            !customDescription.trim() ||
                            customExtracting
                          }
                          className="flex-1"
                        >
                          {customExtracting ? "Adding…" : "Add type"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setShowNewEntityForm(false);
                            setCustomTitle("");
                            setCustomDescription("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowNewEntityForm(true)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M5 1v8M1 5h8" />
                      </svg>
                      New Entity
                    </button>
                  )}
                </div>
              )}
            </div>
              </TabsContent>
              <TabsContent value="notes">
                <div className="flex flex-col gap-4">
                  <NotesPanel
                    documentId={documentId}
                    activeId={activeAnnotationId}
                    onActivate={setActiveAnnotationId}
                    onNavigate={scrollToPage}
                    onSeek={
                      isRecording
                        ? (seconds) => recordingRef.current?.seekTo(seconds)
                        : undefined
                    }
                  />
                </div>
              </TabsContent>
              <TabsContent value="info">
                <div className="flex flex-col gap-4">
                  {document && (
                    <div className="flex items-center justify-between rounded-md border px-2.5 py-1.5">
                      <span className="text-xs text-muted-foreground">
                        Manage document
                      </span>
                      <DocumentActions
                        documentId={document._id}
                        documentName={document.name}
                        projectId={document.projectId}
                        onDeleted={() =>
                          navigate(projectSlug ? `/p/${projectSlug}` : "/")
                        }
                      />
                    </div>
                  )}
                  {document && <DocumentTagsAndMetadata document={document} />}
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

                  <DocumentUsage documentId={documentId} />


                  {/* Page-level view controls: not document properties, so
                      they sit at the bottom rather than beside Name/Media. */}
                  {isPdfDocument && (
                    <div className="flex flex-col gap-1.5 border-t pt-3">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        View
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void rotateDocument({ id: documentId, degrees: 90 })
                          }
                        >
                          ↻ Rotate all pages
                        </Button>
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
                    </div>
                  )}
                </div>
              </TabsContent>
                </div>
              </Tabs>
            </div>
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
      <p className="text-2xs text-muted-foreground mt-0.5">
        Locations are approximate, detected by AI.
      </p>
    </div>
  );
}

/**
 * Visual objects stored on the `detections` table, drawn over the rendered PDF
 * page. Their coordinates are already normalized 0-1 against that same page.
 *
 * Only documents ingested before the switch from the full-model completion to
 * `task: "ocr"` have any — nothing writes the table today, so this renders for
 * a shrinking subset of the library. See the note in `convex/detections.ts`
 * before assuming a document is missing detections because of a bug here.
 */
function VisualObjectOverlay({
  pageNumber,
  detections,
}: {
  pageNumber: number; // 1-based
  detections: Doc<"detections">[];
}) {
  const pageIndex = pageNumber - 1;
  // No y-correction any more. It existed to reconcile OCR geometry against a
  // server-rendered raster whose aspect ratio could differ from the OCR page;
  // there is no raster, and detection boxes are already normalised 0-1 against
  // the same page the overlay is drawn on.

  return detections
    .filter((detection) => detection.pageNumber === pageIndex && detection.bbox)
    .map((detection) => {
      const bbox = detection.bbox!;
      const top = Math.min(1, Math.max(0, bbox.y));
      const height = Math.min(1 - top, Math.max(0, bbox.height));
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
          <span className="absolute -top-5 left-0 rounded bg-orange-500 px-1 py-0.5 text-viewer-label font-semibold leading-none text-white whitespace-nowrap">
            {detection.label.replace(/_/g, " ")}
          </span>
        </div>
      );
    });
}

// ---------------------------------------------------------------------------
// Document description (top of the details panel) and metadata detail
// (Kind/type identity now lives in the title bar's pill + ⋮ menu; only tags
// and the extracted-metadata table stay editable here, in the Info tab.)
// ---------------------------------------------------------------------------

interface ExtractedMetadata {
  title?: string;
  summary?: string;
  date?: string;
  author?: string;
  language?: string;
  additional?: { key: string; value: string }[];
}

function useExtractedMetadata(document: Doc<"documents">) {
  return useMemo<ExtractedMetadata | null>(() => {
    if (!document.metadata) return null;
    try {
      return JSON.parse(document.metadata) as ExtractedMetadata;
    } catch {
      return null;
    }
  }, [document.metadata]);
}

/**
 * The only thing pinned above the tabs: Analyze's own description of the
 * document. Renders nothing — not even its border — until there is one, so a
 * document still being analyzed doesn't show an empty strip.
 */
function DocumentSummary({ document }: { document: Doc<"documents"> }) {
  const meta = useExtractedMetadata(document);
  if (!meta?.summary) return null;
  return (
    // pr-9 leaves room for the panel's minimize button (see ViewerLayout).
    <div className="max-h-[35%] shrink-0 overflow-y-auto border-b px-4 pt-3 pb-3 pr-9">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground">
        Document Description
      </h2>
      <p className="text-sm leading-relaxed text-foreground">
        {meta.summary}
      </p>
    </div>
  );
}

/** Tag editing and the extracted-metadata table, for the Info tab. */
function DocumentTagsAndMetadata({ document }: { document: Doc<"documents"> }) {
  const updateDocumentMeta = useMutation(api.metadata.updateDocumentMeta);
  const [tagsDraft, setTagsDraft] = useState<string | null>(null);
  const meta = useExtractedMetadata(document);

  const tags = tagsDraft ?? (document.tags ?? []).join(", ");
  const dirty = tagsDraft !== null && tagsDraft !== (document.tags ?? []).join(", ");

  async function save() {
    if (tagsDraft === null) return;
    await updateDocumentMeta({
      documentId: document._id,
      tags: tagsDraft
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    });
    setTagsDraft(null);
  }

  return (
    <div className="flex flex-col gap-3">
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
        <Button size="sm" variant="outline" onClick={save} className="self-start">
          Save
        </Button>
      )}

      {meta && (
        <div className="flex flex-col gap-1.5 text-sm border-t pt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Extracted metadata
          </h4>
          {[
            ["Title", meta.title],
            ["Date", meta.date],
            // From the document row, not `meta` — the place is sanitized on
            // the way in (convex/metadata.ts) rather than left in the raw blob.
            ["Place", document.documentPlace],
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

// ---------------------------------------------------------------------------
// Research dossier display component (structured)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dossier sub-components
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Citation chip with hover tooltip
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cross-document indicator: shows which other documents an entity appears in
// ---------------------------------------------------------------------------



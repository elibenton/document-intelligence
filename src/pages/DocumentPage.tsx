import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useSearchParams, Link, useNavigate } from "react-router";
import { ExternalLink, FileText, Folder, Globe, Sparkles } from "lucide-react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import {
  PdfViewer,
  type ActiveAnnotation,
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
import { DndContext, DragOverlay, pointerWithin } from "@dnd-kit/core";
import {
  EntityMergeDialog,
  MergeUndoBar,
} from "@/components/entities/EntityMergeDialog";
import { MergeDropRow } from "@/components/entities/MergeDropRow";
import { useEntityMergeDnd } from "@/components/entities/useEntityMergeDnd";
import { ViewerLayout } from "@/components/viewer/ViewerLayout";
import { ViewerMetaBar } from "@/components/viewer/ViewerMetaBar";
import { ContentsPanel } from "@/components/viewer/ContentsPanel";
import { NotesPanel } from "@/components/viewer/NotesPanel";
import { buildTocHeaders, sectionForPage } from "@/components/viewer/tocHeaders";
import { ZoomControl } from "@/components/viewer/ZoomControl";
import { HighlighterTool } from "@/components/viewer/HighlighterTool";
import type { AnnotationColor } from "@/components/viewer/annotationColors";
import { useViewerZoom } from "@/components/viewer/useViewerZoom";
import { PageOverlays } from "@/components/viewer/PageOverlays";
import {
  bestSearchVariant,
  findPersonMentions,
} from "@/components/viewer/personMentions";
import type { EntityHover } from "@/components/viewer/EntityHighlights";
import { PipelineProgress } from "@/components/documents/PipelineProgress";
import { DocumentUsage } from "@/components/documents/DocumentUsage";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { DocumentInfoPanel } from "@/components/documents/DocumentInfoPanel";
import { formatDuration } from "@/lib/duration";
import { EditableText } from "@/components/ui/editable";
import { buildDocumentFacts } from "@/lib/documentFacts";
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
import { buttonVariants } from "@/components/ui/button-variants";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { isAudioVideo } from "@/components/documents/docStatus";
import { documentTitles } from "@/lib/documentTitle";
import { isCsvDocument } from "@/lib/uploadTypes";
import type { Id } from "../../convex/_generated/dataModel";
import { isTypingTarget } from "@/lib/isTypingTarget";
import { usePersistedStringSet } from "@/hooks/usePersistedDisclosure";

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
  // Recordings: segment times for TOC/search navigation. The same
  // subscription RecordingView holds, so Convex dedupes it.
  const isRecordingDoc = Boolean(document && isAudioVideo(document));
  const transcriptSegments = useQuery(
    api.transcripts.byDocument,
    isRecordingDoc ? { documentId } : "skip"
  );
  // The same subscription the viewer and Notes panel already hold, so the tab
  // count is free — Convex dedupes identical queries across components.
  const annotations = useQuery(api.annotations.byDocument, { documentId });
  const translatedPages = useQuery(api.translations.pagesByDocument, {
    documentId,
  });
  const retryTranslation = useMutation(api.translations.retry);
  const rotateDocument = useMutation(api.documents.rotateDocument);
  const updateIdentity = useMutation(api.documents.updateIdentity);
  const runSuggestedExtraction = useAction(api.suggestedEntities.runExtraction);

  const [currentPage, setCurrentPage] = useState(1);
  const [showBlocks, setShowBlocks] = useState(false);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  /** Entity names whose connections are showing beneath them. Persisted, as
   *  is every caret: reopening the document keeps the user's choices. */
  const [expandedEntities, setExpandedEntities] = usePersistedStringSet(
    "doc:expanded-entity-connections"
  );
  const [collapsedGroups, setCollapsedGroups] = usePersistedStringSet(
    "doc:collapsed-entity-groups"
  );
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
  // Which highlight has a popover open (and which one — the add-note/delete
  // offer or the full comment card). Lives here because both the page and the
  // notes list drive it — clicking a note opens the card on the page.
  const [activeAnnotation, setActiveAnnotation] =
    useState<ActiveAnnotation | null>(null);
  // The armed highlighter color, or null when the pen is away. Lives here
  // because the tool floats in the layout while the commit happens inside
  // whichever viewer (PDF or transcript) is mounted.
  const [penColor, setPenColor] = useState<AnnotationColor | null>(null);

  // Drag-to-merge in the entity sidebar: dropping one row on another opens
  // the same survivor picker the merge queue uses. Shared machinery with the
  // project page's Entities panel (useEntityMergeDnd).
  const mergeDnd = useEntityMergeDnd(documentEntities);

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

  // Jump the viewer to an entity's first occurrence: page scroll for paged
  // documents, a seek for recordings (the mention's block is a transcript
  // mirror row, whose blockId names the segment and so the second).
  const jumpToFirstMention = (
    first: ReturnType<typeof findPersonMentions>[number] | undefined
  ) => {
    if (!first) return;
    if (isRecordingDoc) {
      const row = blocks?.find((b) => b._id === first.blockId);
      const seg = row?.blockId?.match(/^transcript_seg(\d+)$/);
      const time = seg
        ? transcriptSegments?.[Number(seg[1])]?.startTime
        : undefined;
      if (time !== undefined) seekTo(time);
      return;
    }
    scrollToPage(first.pageNumber + 1);
  };

  const seekTo = useCallback((seconds: number) => {
    recordingRef.current?.seekTo(seconds);
  }, []);

  // Which timed TOC section the playhead is in — reported by RecordingView
  // only when it changes, and handed to the Contents panel as the active row.
  const [activeSection, setActiveSection] = useState(-1);
  const sectionTimes = useMemo(() => {
    const entries = document?.tableOfContents ?? [];
    return entries.length > 0 && entries.every((e) => e.time !== undefined)
      ? entries.map((e) => e.time ?? 0)
      : undefined;
  }, [document?.tableOfContents]);

  // Transcript blocks were ingested one per segment, in segment order, so
  // zipping the block rows against the segments recovers each block's
  // segment. Guarded on equal lengths: a transcript mid-replacement zips
  // wrong.
  const segmentByBlockId = useMemo(() => {
    if (!isRecordingDoc || !blocks || !transcriptSegments) return undefined;
    if (blocks.length !== transcriptSegments.length) return undefined;
    const map = new Map<string, (typeof transcriptSegments)[number]>();
    blocks.forEach((block, i) => {
      map.set(block._id as string, transcriptSegments[i]);
    });
    return map;
  }, [isRecordingDoc, blocks, transcriptSegments]);

  // The second a search hit is spoken — the word under the hit's offset, not
  // the segment's start, which for a long turn can be minutes earlier.
  const hitTime = useCallback(
    (hit: { blockId: string; blockOffset: number }) => {
      const segment = segmentByBlockId?.get(hit.blockId);
      if (!segment) return undefined;
      // Segment text is its words joined by single spaces, so walking the
      // words' cumulative lengths locates the word at the offset.
      let pos = 0;
      for (const word of segment.words) {
        const end = pos + word.word.length;
        if (hit.blockOffset <= end) return word.start;
        pos = end + 1;
      }
      return segment.startTime;
    },
    [segmentByBlockId]
  );

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
  const isWebClip = document?.mediaType === "webScrape";
  // The clip's escape hatch: swap the archived snapshot for the parsed
  // article text when the archive is unusable (a captured popup, dead CSS).
  const [clipView, setClipView] = useState<"archive" | "text">("archive");

  // Recordings get the Contents panel too: transcript segments are blocks,
  // so search works, and the understand pass writes a table of contents for
  // audio as well. Only CSVs have nothing to navigate.
  const showContentsTab = !isCsv;
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

  // Precompute mentions per entity item across all groups — matched against
  // every spelling the entity has carried (renames and merges teach aliases),
  // so the row still lights up when the text says "Eli" and the entity says
  // "Eli Cohen".
  const mentionData = useMemo(() => {
    if (!blocks) return new Map<string, ReturnType<typeof findPersonMentions>>();
    const variantsByName = new Map<string, string[]>();
    for (const entity of documentEntities ?? []) {
      variantsByName.set(entity.name, [entity.name, ...(entity.aliases ?? [])]);
    }
    const map = new Map<string, ReturnType<typeof findPersonMentions>>();
    for (const group of entityGroups) {
      for (const item of group.items) {
        if (!map.has(item)) {
          map.set(
            item,
            findPersonMentions(blocks, variantsByName.get(item) ?? [item])
          );
        }
      }
    }
    return map;
  }, [entityGroups, blocks, documentEntities]);

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
    const label = customTitle.trim();
    const description = customDescription.trim();
    setCustomExtracting(true);
    try {
      await addEntityType({
        projectId: document.projectId,
        label,
        description,
      });
      // The declared type joins the vocabulary for future documents — and
      // runs against THIS document right away, so the person who just typed
      // it sees its entities appear instead of a note telling them to re-run.
      await runSuggestedExtraction({
        documentId,
        types: [{ label, description }],
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
  const titleFacts = buildDocumentFacts(document).title;
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
    // Flat, edge-to-edge chrome: one hairline header bar over three flush
    // columns. No canvas tint, no floating cards — the hairline borders do
    // all the separating.
    <div className="flex h-screen flex-col bg-background">
      {document.projectId && (
        <ProjectSearchDialog projectId={document.projectId} />
      )}
      <EntityMergeDialog
        pair={mergeDnd.mergePair}
        description={
          mergeDnd.mergePair
            ? `You dropped “${mergeDnd.mergePair.a.name}” onto “${mergeDnd.mergePair.b.name}”.`
            : ""
        }
        error={mergeDnd.mergeError}
        busy={mergeDnd.mergeBusy}
        onMerge={mergeDnd.runMerge}
        onClose={mergeDnd.closeDialog}
      />
      {/* The underline is inset from both edges, matching the home page's
          divider rules rather than running the full window width. */}
      <header className="relative flex h-14 shrink-0 items-center gap-3 px-3 after:absolute after:inset-x-3 after:bottom-0 after:h-px after:rounded-full after:bg-border">
        <Link
          to={projectSlug ? `/p/${projectSlug}` : "/"}
          title="Back to project"
          aria-label="Back to project"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Folder className="size-4" />
        </Link>
        {/* The title edits in place (the EntityPage pattern) — the ⋮ identity
            menu is retired; kinds edit in the Info panel and the library's
            chips. Clearing the title tombstones it back to the filename. */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="min-w-0 text-base font-semibold leading-tight text-foreground">
              <EditableText
                value={titles.primary}
                multiline
                label="Edit title"
                placeholder={document.name}
                provenance={titleFacts.provenance}
                candidates={titleFacts.candidates}
                clearMode="clear"
                className="max-w-full"
                renderValue={(value) => (
                  <span className="truncate">{value}</span>
                )}
                onCommit={(next) =>
                  updateIdentity({ id: document._id, displayName: next })
                }
              />
            </h1>
            {titles.original && (
              <p className="truncate text-xs leading-tight text-muted-foreground">
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
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* The working tools live here now rather than floating over the
              viewer: highlighter, then zoom + page counter, quietly right of
              the title. Pipeline status lives at the top of the Details
              column, where a step list has the room a header bar doesn't. */}
          {isWebClip && document.textUrl && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setClipView((v) => (v === "archive" ? "text" : "archive"))
              }
            >
              {clipView === "archive" ? (
                <>
                  <FileText className="size-3.5" />
                  Text view
                </>
              ) : (
                <>
                  <Globe className="size-3.5" />
                  Archive view
                </>
              )}
            </Button>
          )}
          {isWebClip && document.sourceUrl && (
            <a
              href={document.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              View original <ExternalLink className="size-3" />
            </a>
          )}
          {(isPdfDocument || isRecording || isWebClip) && (
            <HighlighterTool color={penColor} onChange={setPenColor} />
          )}
          {isPdfDocument && (
            <ZoomControl
              zoom={zoom}
              onZoomChange={chooseZoom}
              onFitWidth={fitToWidth}
              currentPage={currentPage}
              totalPages={totalPages ?? 0}
            />
          )}
          {translationInProgress && (
            <span className="text-xs text-muted-foreground">Translating…</span>
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
              className="flex h-8 items-center rounded-md bg-muted p-0.5"
              aria-label="Document language view"
            >
              <button
                type="button"
                onClick={() => setLanguageView("translated")}
                className={cn(
                  "flex h-full items-center rounded px-3 text-xs transition-colors",
                  languageView === "translated"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Translated
              </button>
              <button
                type="button"
                onClick={() => setLanguageView("original")}
                className={cn(
                  "flex h-full items-center rounded px-3 text-xs transition-colors",
                  languageView === "original"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
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
          // Web clips read as one page, so the Contents panel starts closed
          // for them — remembered separately from the paged-document layout.
          storageKey={isWebClip ? "viewer-layout-webclip" : undefined}
          defaultLeftCollapsed={isWebClip}
          left={
            showContentsTab ? (
              <div className="h-full overflow-hidden">
              <ContentsPanel
                blocks={blocks ?? []}
                outline={document.tableOfContents}
                currentPage={currentPage}
                totalPages={totalPages ?? 0}
                onNavigate={scrollToPage}
                onSeek={isRecording ? seekTo : undefined}
                hitTime={segmentByBlockId ? hitTime : undefined}
                activeSection={isRecording ? activeSection : undefined}
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
          viewer={
            // w-full is load-bearing: this is a flex item in ViewerLayout's
            // justify-center pane, and without a width it collapses to its
            // content's intrinsic width — an iframe's is 300px, which
            // rendered archived pages at their mobile breakpoint.
            <div className="flex h-full w-full min-w-0 flex-col">
              <ViewerMetaBar document={document} />
              <div className="min-h-0 flex-1">
            {isRecording ? (
              <RecordingView
                ref={recordingRef}
                document={document}
                url={url}
                showTranslation={
                  hasTranslatedContent && languageView === "translated"
                }
                penColor={penColor}
                sectionTimes={sectionTimes}
                onActiveSectionChange={setActiveSection}
                searchTerm={activeSearch ?? undefined}
              />
            ) : hasTranslatedContent && languageView === "translated" ? (
              <TranslatedDocumentView pages={translatedPages ?? []} />
            ) : url ? (
              isWebClip ? (
                <WebClipViewer
                  documentId={documentId}
                  url={url}
                  textUrl={document.textUrl}
                  view={clipView}
                  penColor={penColor}
                  activeAnnotation={activeAnnotation}
                  onActiveAnnotationChange={setActiveAnnotation}
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
                  activeAnnotation={activeAnnotation}
                  onActiveAnnotationChange={setActiveAnnotation}
                  penColor={penColor}
                />
              ) : null
            ) : (
              <div className="flex flex-col items-center justify-center h-96 gap-3">
                <Spinner className="size-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Loading document…</p>
              </div>
            )}
              </div>
            </div>
          }
          sidebar={
            <div className="flex h-full flex-col overflow-hidden">
              {/* Pipeline status while the document is still cooking (and any
                  failure needing a retry). Compact renders the bare step
                  list — no card — and nothing at all once processing is
                  cleanly done; empty:hidden folds the section away with it. */}
              <div className="shrink-0 border-b px-4 py-3 empty:hidden">
                <PipelineProgress document={document} compact />
              </div>
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
                    <TabsTrigger value="notes">
                      Notes
                      {/* Silent at zero, like the Library's Notes column. */}
                      {(annotations?.length ?? 0) > 0 && (
                        <span className="ml-1.5 text-xs font-normal tabular-nums text-muted-foreground">
                          {annotations!.length}
                        </span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="info">Info</TabsTrigger>
                  </TabsList>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <TabsContent value="entities">
            <DndContext
              sensors={mergeDnd.sensors}
              collisionDetection={pointerWithin}
              onDragStart={mergeDnd.onDragStart}
              onDragEnd={mergeDnd.onDragEnd}
              onDragCancel={mergeDnd.onDragCancel}
            >
            <div className="flex flex-col gap-4">
              <MergeUndoBar undo={mergeDnd.mergeUndo} onUndo={mergeDnd.undoLast} />
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
                        const mentions = mentionData.get(item) ?? [];
                        const mentionCount = mentions.length;
                        // The spelling that actually occurs in this document
                        // — search for that, not for a name the text never
                        // spells out.
                        const searchTerm = bestSearchVariant(mentions) ?? item;
                        const crossDoc = crossDocMap.get(item.toLowerCase());
                        const role = roleByName.get(item.toLowerCase());
                        const connections = crossDoc
                          ? connectionsByEntity.get(crossDoc.entityId) ?? []
                          : [];
                        const isExpanded = expandedEntities.has(item);

                        return (
                          <MergeDropRow
                            key={item}
                            entityId={crossDoc?.entityId}
                            name={item}
                            suppressClickRef={mergeDnd.suppressClickRef}
                          >
                            {({ handleProps, isDragging }) => (
                          <div
                            className={cn(
                              "border-b border-border/50 last:border-0",
                              isDragging && "opacity-40"
                            )}
                          >
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
                                title={isExpanded ? "Hide details" : "Show details"}
                                aria-label={
                                  isExpanded
                                    ? `Hide details for ${item}`
                                    : `Show details for ${item}`
                                }
                                aria-expanded={isExpanded}
                                className="shrink-0 pl-1 pr-0.5 py-1.5"
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
                                {...handleProps}
                                onClick={() => {
                                  if (mergeDnd.suppressClickRef.current) return;
                                  if (isActive) {
                                    setSelectedItem(null);
                                    setSearchQuery("");
                                  } else {
                                    setSelectedItem(item);
                                    setSearchQuery(searchTerm);
                                    jumpToFirstMention(mentions[0]);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter" && e.key !== " ") return;
                                  e.preventDefault();
                                  setSelectedItem(isActive ? null : item);
                                  setSearchQuery(isActive ? "" : searchTerm);
                                  if (!isActive) jumpToFirstMention(mentions[0]);
                                }}
                                title={
                                  isActive
                                    ? "Clear highlight"
                                    : mentionCount > 0
                                      ? `Highlight ${searchTerm} in the document`
                                      : `"${item}" was not found in the document text`
                                }
                                className={cn(
                                  "flex flex-1 cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left text-sm transition-colors",
                                  isActive
                                    ? "bg-purple-50 font-semibold text-purple-900 dark:bg-purple-950/50 dark:text-purple-100"
                                    : "hover:bg-accent"
                                )}
                              >
                                {/* Plain text: the whole row is the highlight
                                    gesture, and the entity page moved into
                                    the row's dropdown. */}
                                <span className="min-w-0 flex-1 truncate">
                                  {item}
                                </span>
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
                              <div className="flex flex-col gap-2 pb-2 pl-5 pr-2">
                                {connections.length > 0 ? (
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
                                ) : (
                                  <p className="text-xs text-muted-foreground">
                                    No connections in this document.
                                  </p>
                                )}
                                <EntityOtherDocuments
                                  entityId={crossDoc.entityId}
                                  currentDocumentId={documentId}
                                />
                                <EntityReassign
                                  documentId={documentId}
                                  entityId={crossDoc.entityId}
                                  entityName={item}
                                />
                                <Link
                                  to={`/entity/${entitySlug(item)}${
                                    document.projectId
                                      ? `?project=${document.projectId}`
                                      : ""
                                  }`}
                                  className={cn(
                                    buttonVariants({
                                      variant: "outline",
                                      size: "sm",
                                    }),
                                    "self-start"
                                  )}
                                >
                                  Open entity page
                                </Link>
                              </div>
                            )}

                          </div>
                            )}
                          </MergeDropRow>
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

              {/* The understand pass's conservative offer of further entity
                  types — tap one or more; the batch fires after a short
                  pause so several taps become one call. */}
              {isParsed && (document.suggestedEntityTypes?.length ?? 0) > 0 && (
                <SuggestedEntityTypes document={document} />
              )}

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
                      <p className="text-2xs leading-snug text-muted-foreground">
                        Extracts from this document now, and applies to
                        documents uploaded from now on.
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
              <DragOverlay>
                {mergeDnd.draggedName && (
                  <div className="flex cursor-grabbing items-center rounded-md border bg-background px-2 py-1 text-sm font-medium shadow-md">
                    {mergeDnd.draggedName}
                  </div>
                )}
              </DragOverlay>
            </DndContext>
              </TabsContent>
              <TabsContent value="notes">
                <div className="flex flex-col gap-4">
                  <NotesPanel
                    documentId={documentId}
                    activeId={activeAnnotation?.id ?? null}
                    // From the notes list the intent is the note itself, so
                    // activation opens the card, not the add-note offer.
                    onActivate={(id) =>
                      setActiveAnnotation(id ? { id, note: true } : null)
                    }
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
                  {document && <DocumentInfoPanel document={document} />}
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
                      {document.durationSeconds !== undefined && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Duration</span>
                          <span>{formatDuration(document.durationSeconds)}</span>
                        </div>
                      )}
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

/**
 * "This document's Michael is a different Michael": move this ONE document's
 * link to another entity — an existing one picked from the live-search list,
 * or a new one made from whatever name is typed. Other documents' links stay
 * where they are; entities.reassignInDocument moves the evidence rows.
 */
function EntityReassign({
  documentId,
  entityId,
  entityName,
}: {
  documentId: Id<"documents">;
  entityId: Id<"entities">;
  entityName: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const reassign = useMutation(api.entities.reassignInDocument);
  // Live candidates for what was typed — only queried while the form is open
  // and something is typed, so the sidebar costs nothing at rest.
  const options = useQuery(
    api.entities.reassignOptions,
    open && name.trim().length >= 2 ? { documentId, query: name.trim() } : "skip"
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-2xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
      >
        Wrong person? Reassign in this document…
      </button>
    );
  }

  const commit = async (targetEntityId?: Id<"entities">) => {
    setBusy(true);
    try {
      await reassign({
        documentId,
        entityId,
        ...(targetEntityId ? { targetEntityId } : { name: name.trim() }),
      });
      setOpen(false);
      setName("");
    } finally {
      setBusy(false);
    }
  };

  const candidates = (options ?? []).filter((o) => o._id !== entityId);

  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-2">
      <p className="text-2xs leading-snug text-muted-foreground">
        Only this document's “{entityName}” moves — pick who it really is, or
        type a fuller name to make a new entity.
      </p>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        placeholder="Full name (e.g. Michael Polson)"
        className="h-8 text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim() && !busy) void commit();
        }}
      />
      {candidates.length > 0 && (
        <div className="flex flex-col">
          {candidates.map((option) => (
            <Button
              key={option._id}
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void commit(option._id)}
              className="h-7 justify-start px-1.5 text-xs font-normal"
            >
              <span className="min-w-0 truncate">{option.name}</span>
              <span className="shrink-0 text-2xs capitalize text-muted-foreground">
                {option.type} · {option.documentCount} doc
                {option.documentCount === 1 ? "" : "s"}
              </span>
            </Button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={!name.trim() || busy}
          onClick={() => void commit()}
          className="flex-1"
        >
          {busy ? "Moving…" : `Use “${name.trim() || "…"}”`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setName("");
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The other documents an entity appears in — the cross-document half of an
 * entity row's dropdown. Fetched only once a row is expanded (this component
 * mounts then), so a sidebar of forty entities costs no extra reads at rest.
 */
function EntityOtherDocuments({
  entityId,
  currentDocumentId,
}: {
  entityId: Id<"entities">;
  currentDocumentId: Id<"documents">;
}) {
  const docs = useQuery(api.entities.documentsForEntity, { entityId });
  if (docs === undefined) {
    return <Skeleton className="h-4 w-40" />;
  }
  const others = docs.filter((d) => d._id !== currentDocumentId);
  if (others.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Not mentioned in any other document.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Also appears in
      </h4>
      {others.slice(0, 5).map((d) => (
        <Link
          key={d._id}
          to={`/documents/${d._id}`}
          className="flex items-baseline gap-1.5 text-xs text-foreground hover:underline"
        >
          <span className="min-w-0 truncate">{d.displayName ?? d.name}</span>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            ×{d.mentionCount}
          </span>
        </Link>
      ))}
      {others.length > 5 && (
        <p className="text-2xs text-muted-foreground">
          and {others.length - 5} more — see the entity page.
        </p>
      )}
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
    // Never scrolls: a long description pushes the tabs down and the panel's
    // own scroll area absorbs the difference.
    <div className="shrink-0 border-b px-4 pt-3 pb-3">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground">
        Document Description
      </h2>
      <p className="text-sm leading-relaxed text-foreground">
        {meta.summary}
      </p>
    </div>
  );
}

/**
 * The understand pass's suggested additional entity types, as tappable
 * chips. Taps batch: each one restarts a short pause, and when it elapses
 * every selected type goes to the extraction in ONE call — so tapping three
 * chips costs one API call, not three. Extraction is one-document-only by
 * design; declaring a type for all future documents stays the New Entity
 * form's job.
 */
const SUGGESTION_BATCH_MS = 2_500;

function SuggestedEntityTypes({ document }: { document: Doc<"documents"> }) {
  const runExtraction = useAction(api.suggestedEntities.runExtraction);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const timerRef = useRef<number | null>(null);
  // The timer's closure would see a stale selection; the ref — written only
  // inside the tap handler, never during render — sees every tap.
  const selectedRef = useRef<Set<string>>(new Set());

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    []
  );

  const toggle = (label: string) => {
    const next = new Set(selectedRef.current);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    selectedRef.current = next;
    setSelected(next);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const chosen = new Set(selectedRef.current);
      const types = (document.suggestedEntityTypes ?? []).filter((s) =>
        chosen.has(s.label)
      );
      if (types.length === 0) return;
      setRunning(true);
      selectedRef.current = new Set();
      setSelected(new Set());
      void runExtraction({ documentId: document._id, types })
        .catch((err) => console.error("Suggested extraction failed:", err))
        .finally(() => setRunning(false));
    }, SUGGESTION_BATCH_MS);
  };

  const suggestions = document.suggestedEntityTypes ?? [];
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Sparkles className="size-3 text-primary" />
        Suggested
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((suggestion) => {
          const isSelected = selected.has(suggestion.label);
          return (
            <button
              key={suggestion.label}
              type="button"
              disabled={running}
              onClick={() => toggle(suggestion.label)}
              title={suggestion.description}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:opacity-50",
                isSelected
                  ? "border-primary bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {suggestion.label}
            </button>
          );
        })}
      </div>
      <p className="text-2xs leading-snug text-muted-foreground">
        {running ? (
          <span className="flex items-center gap-1.5">
            <Spinner className="size-3" />
            Extracting from this document…
          </span>
        ) : selected.size > 0 ? (
          `Extracting ${selected.size} type${
            selected.size === 1 ? "" : "s"
          } in a moment — tap more to include them.`
        ) : (
          "Tap to extract from this document only."
        )}
      </p>
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



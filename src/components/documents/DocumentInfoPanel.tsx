import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useNavigate } from "react-router";
import { ListFilter, Plus, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  EditableDate,
  EditableSelect,
  EditableText,
} from "@/components/ui/editable";
import {
  buildDocumentFacts,
  createdDateLabel,
  type MetadataFact,
} from "@/lib/documentFacts";
import { formatDated } from "@/lib/documentDate";
import { useProjectSlug } from "@/hooks/useProjectSlug";
import { DEFAULT_LIBRARY_VIEW } from "@/lib/views/documentProperties";
import {
  metadataFilterCondition,
  type MetadataFilterField,
} from "@/lib/views/metadataFilters";
import type { FilterCondition, ViewConfig } from "@/lib/views/types";
import { INTERFAZE_LANGUAGES, languageName } from "@/lib/languages";
import { cn } from "@/lib/utils";

/**
 * The Info tab's properties, every row editable in place — the panel that
 * replaced the read-only "Extracted metadata" table and (together with the
 * header title) retired the ⋮ identity popover. Rows commit through the
 * same editors and mutations the chips use, so the Info tab, the viewer
 * bar, and the library never disagree about a value or what clearing does.
 */
export function DocumentInfoPanel({ document }: { document: Doc<"documents"> }) {
  const setField = useMutation(api.documents.setField);
  const updateIdentity = useMutation(api.documents.updateIdentity);
  const facts = buildDocumentFacts(document);

  // "Find others" writes the Library's own saved filter and sends the user
  // there, rather than inventing a second search surface. Read and write go
  // direct instead of through useProjectViews: that hook layers local edits
  // over stored ones behind a debounce, which is right for a toolbar being
  // dragged and wrong for a single deliberate write we then navigate away
  // from. The document may predate projects, hence the "skip".
  const navigate = useNavigate();
  const projectSlug = useProjectSlug(document.projectId);
  const storedViews = useQuery(
    api.projectViews.get,
    document.projectId ? { projectId: document.projectId } : "skip"
  );
  const saveViews = useMutation(api.projectViews.save);

  const applyFilter = async (condition: FilterCondition) => {
    if (!document.projectId) return;
    const base = (storedViews?.library as ViewConfig | undefined) ??
      (DEFAULT_LIBRARY_VIEW as ViewConfig);
    // Replaces rather than appends: "show me these" is what the gesture
    // promises, and silently narrowing an existing filter set would answer a
    // question the user did not ask.
    await saveViews({
      projectId: document.projectId,
      library: { ...base, filters: [condition] },
    });
    navigate(projectSlug ? `/p/${projectSlug}` : "/");
  };

  /** The row-hover affordance, or nothing when the document never said. */
  const findOthers = (
    field: MetadataFilterField,
    value: string | null | undefined,
    noun: string
  ) => {
    const condition = metadataFilterCondition(field, value);
    if (!condition || !document.projectId) return null;
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        title={`Find other documents with the same ${noun}`}
        aria-label={`Find other documents with the same ${noun}`}
        className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
        onClick={() => void applyFilter(condition)}
      >
        <ListFilter aria-hidden="true" />
      </Button>
    );
  };

  const commitText =
    (field: "author" | "documentPlace" | "sourceLanguageCode") =>
    (next: string) =>
      setField({ id: document._id, field, value: next });
  const commitDate =
    (field: "createdDate" | "documentDate") =>
    (next: { value: string; precision: "day" | "month" | "year" | null }) =>
      setField({
        id: document._id,
        field,
        value: next.value,
        precision: next.precision ?? undefined,
      });

  const dateDisplay = (fact: MetadataFact) =>
    fact.value
      ? formatDated({ value: fact.value, precision: fact.precision ?? "day" })
      : null;

  const additional = useMemo(() => {
    if (!document.metadata) return [];
    try {
      const parsed = JSON.parse(document.metadata) as {
        additional?: Array<{ key?: string; value?: string }>;
      };
      return (parsed.additional ?? []).filter(
        (entry) => entry.key?.trim() && entry.value?.trim()
      );
    } catch {
      return [];
    }
  }, [document.metadata]);

  const madeLabel = createdDateLabel(document.mediaType);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 text-sm">
        <Row label="Title">
          <EditableText
            value={facts.title.value}
            multiline
            placeholder={document.name}
            label="Edit title"
            provenance={facts.title.provenance}
            candidates={facts.title.candidates}
            clearMode="clear"
            className="max-w-full"
            onCommit={(next) =>
              updateIdentity({ id: document._id, displayName: next })
            }
          />
        </Row>
        <Row
          label="Type"
          action={findOthers("primaryKind", document.primaryKind, "type")}
        >
          <KindsEditor document={document} />
        </Row>
        <Row
          label="Author"
          action={findOthers("author", facts.author.value, "author")}
        >
          <EditableText
            value={facts.author.value}
            label="Edit author"
            provenance={facts.author.provenance}
            candidates={facts.author.candidates}
            clearMode="clear"
            onCommit={commitText("author")}
          />
        </Row>
        <Row
          label={madeLabel}
          action={findOthers(
            "createdDate",
            facts.createdDate.value,
            `${madeLabel.toLowerCase()} date`
          )}
        >
          <EditableDate
            value={facts.createdDate.value}
            display={dateDisplay(facts.createdDate)}
            label={`Edit ${madeLabel.toLowerCase()} date`}
            provenance={facts.createdDate.provenance}
            candidates={facts.createdDate.candidates}
            clearMode="clear"
            onCommit={commitDate("createdDate")}
          />
        </Row>
        <Row
          label="Date"
          action={findOthers("documentDate", facts.documentDate.value, "date")}
        >
          <EditableDate
            value={facts.documentDate.value}
            display={dateDisplay(facts.documentDate)}
            label="Edit document date"
            provenance={facts.documentDate.provenance}
            candidates={facts.documentDate.candidates}
            clearMode="clear"
            onCommit={commitDate("documentDate")}
          />
        </Row>
        <Row
          label="Place"
          action={findOthers("documentPlace", facts.documentPlace.value, "place")}
        >
          <EditableText
            value={facts.documentPlace.value}
            label="Edit place"
            provenance={facts.documentPlace.provenance}
            candidates={facts.documentPlace.candidates}
            clearMode="clear"
            onCommit={commitText("documentPlace")}
          />
        </Row>
        <Row
          label="Language"
          action={findOthers("sourceLanguageCode", facts.language.value, "language")}
        >
          <EditableSelect
            value={facts.language.value}
            options={INTERFAZE_LANGUAGES.map((l) => ({
              value: l.code,
              label: l.name,
            }))}
            searchable
            label="Edit language"
            provenance={facts.language.provenance}
            candidates={facts.language.candidates.map((candidate) => ({
              ...candidate,
              label: languageName(candidate.value),
            }))}
            clearMode="clear"
            renderValue={(code) => languageName(code)}
            onCommit={commitText("sourceLanguageCode")}
          />
        </Row>
      </div>
      <p className="text-2xs leading-snug text-muted-foreground">
        Date is what the document is about; {madeLabel.toLowerCase()} is when
        the source says it was made.
      </p>

      <TagsEditor document={document} />

      <RescanSection document={document} />

      {additional.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-3 text-sm">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Extracted metadata
          </h4>
          {additional.map((entry) => (
            <div key={entry.key} className="flex justify-between gap-3 text-xs">
              <span className="shrink-0 capitalize text-muted-foreground">
                {entry.key}
              </span>
              <span className="truncate text-right">{entry.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  action,
  children,
}: {
  label: string;
  /** Revealed on hover or keyboard focus; absent for rows with no value. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="group/row flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-0.5 text-right">
        {children}
        {action}
      </span>
    </div>
  );
}

/**
 * The multi-kind editor, lifted from the retired IdentityForm: every kind
 * the corpus knows is a toggle pill, a new one registers project-wide.
 * Commits on every toggle — the row is the value, no Save button.
 */
function KindsEditor({ document }: { document: Doc<"documents"> }) {
  const allKinds = useQuery(
    api.kinds.list,
    document.projectId ? { projectId: document.projectId } : "skip"
  );
  const updateIdentity = useMutation(api.documents.updateIdentity);
  const [newKind, setNewKind] = useState("");

  const kinds =
    document.kinds ?? (document.primaryKind ? [document.primaryKind] : []);
  const known = (allKinds ?? []).map((k) => k.name);
  const options = [...new Set([...known, ...kinds])];

  const commit = (next: string[]) =>
    void updateIdentity({ id: document._id, kinds: next });

  return (
    <Popover>
      <PopoverTrigger
        onClick={(e) => e.stopPropagation()}
        title="Edit document type"
        aria-label="Edit document type"
        className={cn(
          "inline-flex max-w-full items-center gap-1 rounded px-0.5 text-left",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "data-[popup-open]:bg-accent",
          kinds.length === 0 && "italic text-muted-foreground"
        )}
      >
        <span className="truncate">
          {kinds.length > 0 ? kinds.join(", ") : "—"}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1.5 p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
          {options.length === 0 && (
            <p className="text-2xs text-muted-foreground">
              No types yet — add one below.
            </p>
          )}
          {options.map((kind) => {
            const selected = kinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() =>
                  commit(
                    selected
                      ? kinds.filter((k) => k !== kind)
                      : [...kinds, kind]
                  )
                }
                aria-pressed={selected}
                className={cn(
                  "inline-flex items-center gap-1 rounded-4xl border px-2 py-0.5 text-xs transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-transparent bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-accent"
                )}
              >
                {kind}
                {selected && <X className="h-3 w-3" />}
              </button>
            );
          })}
        </div>
        <div className="flex gap-1">
          <Input
            value={newKind}
            aria-label="Add a document type"
            placeholder="Add a type…"
            onChange={(e) => setNewKind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newKind.trim()) {
                e.preventDefault();
                const kind = newKind.trim().toLowerCase();
                if (!kinds.includes(kind)) commit([...kinds, kind]);
                setNewKind("");
              }
            }}
            className="h-7 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2"
            disabled={!newKind.trim()}
            onClick={() => {
              const kind = newKind.trim().toLowerCase();
              if (!kinds.includes(kind)) commit([...kinds, kind]);
              setNewKind("");
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The Info tab's re-run controls, available on every document — bad early
 * extractions are what they exist to fix. Three tiers, cheapest last:
 * re-scan re-runs the extraction (task call for files, local re-parse for
 * clips) then everything downstream; re-analyze re-reads the stored text;
 * re-extract redoes only the entity graph. Every re-run bypasses the
 * provider cache — a replay of the result the user is escaping is worthless.
 */
function RescanSection({ document }: { document: Doc<"documents"> }) {
  const rerunPipeline = useMutation(api.processing.runFullPipeline);
  const reclip = useMutation(api.clips.reclip);
  const reanalyze = useMutation(api.processing.runAnalyze);
  const reextract = useAction(api.relationships.reextract);
  const [busy, setBusy] = useState<"scan" | "analyze" | "extract" | null>(null);

  const isClip = document.mediaType === "webScrape";
  const isRecording =
    document.mediaType === "audio" || document.mediaType === "video";
  const scanLabel = isClip
    ? "Re-clip from archive"
    : isRecording
      ? "Re-transcribe"
      : "Re-scan";

  const run = (kind: "scan" | "analyze" | "extract") => async () => {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === "scan") {
        if (isClip) await reclip({ documentId: document._id });
        else
          await rerunPipeline({ documentId: document._id, bypassCache: true });
      } else if (kind === "analyze") {
        await reanalyze({ documentId: document._id, bypassCache: true });
      } else {
        await reextract({ documentId: document._id });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 border-t pt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Processing
      </h4>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || document.status === "parsing"}
          title={
            isClip
              ? "Re-reads the saved page locally, then re-analyzes — free"
              : isRecording
                ? "Fresh transcription of the recording, then re-analyze — replaces the transcript"
                : "Fresh scan of the file, then re-analyze — replaces the text; highlights keep their place"
          }
          onClick={() => void run("scan")()}
        >
          {busy === "scan" || document.status === "parsing"
            ? "Re-scanning…"
            : scanLabel}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          title="Re-reads the stored text — type, title, dates, contents, and entities"
          onClick={() => void run("analyze")()}
        >
          {busy === "analyze" ? "Re-analyzing…" : "Re-analyze"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          title="Redoes only the entity graph from the stored text — keeps the analysis"
          onClick={() => void run("extract")()}
        >
          {busy === "extract" ? "Re-extracting…" : "Re-extract entities"}
        </Button>
      </div>
      <p className="text-2xs leading-snug text-muted-foreground">
        Re-scan redoes everything from the original
        {isClip ? " archive" : " file"}; re-analyze and re-extract work from
        the stored text.
      </p>
    </div>
  );
}

/** The comma-separated tags input, moved verbatim from the old Info block. */
function TagsEditor({ document }: { document: Doc<"documents"> }) {
  const updateDocumentMeta = useMutation(api.metadata.updateDocumentMeta);
  const [tagsDraft, setTagsDraft] = useState<string | null>(null);

  const tags = tagsDraft ?? (document.tags ?? []).join(", ");
  const dirty =
    tagsDraft !== null && tagsDraft !== (document.tags ?? []).join(", ");

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
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        Tags (comma-separated)
      </label>
      <Input
        value={tags}
        placeholder="e.g. litigation, 2024"
        onChange={(e) => setTagsDraft(e.target.value)}
        className="h-8 text-xs"
      />
      {dirty && (
        <Button size="sm" variant="outline" onClick={save} className="self-start">
          Save
        </Button>
      )}
    </div>
  );
}

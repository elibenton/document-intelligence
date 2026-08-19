import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus, X } from "lucide-react";
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
        <Row label="Type">
          <KindsEditor document={document} />
        </Row>
        <Row label="Author">
          <EditableText
            value={facts.author.value}
            label="Edit author"
            provenance={facts.author.provenance}
            candidates={facts.author.candidates}
            clearMode="clear"
            onCommit={commitText("author")}
          />
        </Row>
        <Row label={madeLabel}>
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
        <Row label="Date">
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
        <Row label="Place">
          <EditableText
            value={facts.documentPlace.value}
            label="Edit place"
            provenance={facts.documentPlace.provenance}
            candidates={facts.documentPlace.candidates}
            clearMode="clear"
            onCommit={commitText("documentPlace")}
          />
        </Row>
        <Row label="Language">
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
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 justify-end text-right">{children}</span>
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

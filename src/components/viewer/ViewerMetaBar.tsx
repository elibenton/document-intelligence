import { Globe, FileText, Image as ImageIcon, Mic, Film } from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { EditableDate, EditableText } from "@/components/ui/editable";
import {
  buildDocumentFacts,
  createdDateLabel,
  type MetadataFact,
} from "@/lib/documentFacts";
import { formatDated } from "@/lib/documentDate";
import { formatDuration } from "@/lib/duration";

/**
 * The one metadata strip above every viewer: what the source says about
 * itself — byline, published/recorded/taken/created date, duration, pages —
 * every value hover-editable in place (editable.tsx), with provenance and
 * the retained native/AI candidates inside the open editor. Replaces the
 * per-viewer one-off bars; the values come from buildDocumentFacts, so the
 * bar never substitutes uploadedAt for a date the source didn't state.
 */
export function ViewerMetaBar({ document }: { document: Doc<"documents"> }) {
  const setField = useMutation(api.documents.setField);
  const media = document.mediaType;

  // Nothing to say before the parse lands; PipelineProgress owns that phase.
  if (document.status === "uploaded" || document.status === "parsing") {
    return null;
  }
  // The CSV viewer has its own shape-stats bar, and a spreadsheet rarely
  // states a creation date; a permanently empty strip would be noise.
  if (media === "csv" || media === undefined) return null;

  const facts = buildDocumentFacts(document);

  const commitText = (field: "author") => (next: string) =>
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

  const dateFact = facts.createdDate;
  const dateEditor = (
    <EditableDate
      value={dateFact.value}
      display={
        dateFact.value ? (
          <span>
            {createdDateLabel(media).toLowerCase()}{" "}
            <span className="text-foreground">
              {formatDated({
                value: dateFact.value,
                precision: dateFact.precision ?? "day",
              })}
            </span>
          </span>
        ) : null
      }
      placeholder={`${createdDateLabel(media).toLowerCase()} —`}
      label={`Edit ${createdDateLabel(media).toLowerCase()} date`}
      provenance={dateFact.provenance}
      candidates={dateFact.candidates}
      clearMode="clear"
      onCommit={commitDate("createdDate")}
    />
  );

  const authorEditor = (fact: MetadataFact) => (
    <EditableText
      value={fact.value}
      placeholder="author —"
      label="Edit author"
      provenance={fact.provenance}
      candidates={fact.candidates}
      clearMode="clear"
      renderValue={(value) => <span className="text-foreground">{value}</span>}
      onCommit={commitText("author")}
    />
  );

  const dot = <span aria-hidden="true">·</span>;
  const domain = (() => {
    if (!document.sourceUrl) return null;
    try {
      return new URL(document.sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();
  const duration = formatDuration(document.durationSeconds);

  let icon = <FileText className="size-3.5 shrink-0" aria-hidden="true" />;
  let line: React.ReactNode = null;
  if (media === "webScrape") {
    icon = <Globe className="size-3.5 shrink-0" aria-hidden="true" />;
    line = (
      <>
        {domain && <span className="truncate">{domain}</span>}
        {domain && dot}
        {authorEditor(facts.author)}
        {dot}
        {dateEditor}
      </>
    );
  } else if (media === "audio" || media === "video") {
    icon =
      media === "audio" ? (
        <Mic className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Film className="size-3.5 shrink-0" aria-hidden="true" />
      );
    line = (
      <>
        {dateEditor}
        {duration && dot}
        {duration && <span>{duration}</span>}
      </>
    );
  } else if (media === "image") {
    icon = <ImageIcon className="size-3.5 shrink-0" aria-hidden="true" />;
    line = dateEditor;
  } else {
    // pdf and anything paged
    line = (
      <>
        {authorEditor(facts.author)}
        {dot}
        {dateEditor}
        {document.pageCount ? (
          <>
            {dot}
            <span>
              {document.pageCount} {document.pageCount === 1 ? "page" : "pages"}
            </span>
          </>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
      {icon}
      <div className="flex min-w-0 flex-1 items-center gap-2">{line}</div>
    </div>
  );
}

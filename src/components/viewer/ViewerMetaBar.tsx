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
 * The one metadata line for every document: what the source says about
 * itself — byline, published/recorded/taken/created date, the "about" date,
 * duration — every value hover-editable in place (editable.tsx), with
 * provenance and the retained native/AI candidates inside the open editor.
 * Rendered as the page header's second row (DocumentPage), so it carries no
 * chrome of its own; the values come from buildDocumentFacts, so the line
 * never substitutes uploadedAt for a date the source didn't state.
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

  // The two dates share one editor shape: createdDate wears its per-media
  // verb ("published", "recorded"…) and documentDate is always "about" —
  // the same distinction the Info panel's microcopy spells out.
  const labeledDateEditor = (
    field: "createdDate" | "documentDate",
    fact: MetadataFact,
    label: string
  ) => (
    <EditableDate
      value={fact.value}
      display={
        fact.value ? (
          <span>
            {label}{" "}
            <span className="text-foreground">
              {formatDated({
                value: fact.value,
                precision: fact.precision ?? "day",
              })}
            </span>
          </span>
        ) : null
      }
      placeholder={`${label} —`}
      label={`Edit ${label === "about" ? "document" : label} date`}
      provenance={fact.provenance}
      candidates={fact.candidates}
      clearMode="clear"
      onCommit={commitDate(field)}
    />
  );
  const dateEditor = labeledDateEditor(
    "createdDate",
    facts.createdDate,
    createdDateLabel(media).toLowerCase()
  );
  const aboutEditor = labeledDateEditor("documentDate", facts.documentDate, "about");

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
  const duration = formatDuration(document.durationSeconds);

  // The media icon lives beside the title in the header; the domain and the
  // page count live on the title's secondary line. This row is only the
  // editable facts.
  let line: React.ReactNode;
  if (media === "webScrape") {
    line = (
      <>
        {authorEditor(facts.author)}
        {dot}
        {dateEditor}
      </>
    );
  } else if (media === "audio" || media === "video") {
    line = (
      <>
        {dateEditor}
        {dot}
        {aboutEditor}
        {duration && dot}
        {duration && <span>{duration}</span>}
      </>
    );
  } else if (media === "image") {
    line = (
      <>
        {dateEditor}
        {dot}
        {aboutEditor}
      </>
    );
  } else {
    // pdf and anything paged
    line = (
      <>
        {authorEditor(facts.author)}
        {dot}
        {dateEditor}
        {dot}
        {aboutEditor}
      </>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      {line}
    </div>
  );
}

import { Link } from "react-router";
import type { Doc } from "../../../convex/_generated/dataModel";
import { DocTypePills } from "@/components/documents/DocTypePills";
import { EmptyState } from "@/components/ui/empty-state";
import { entitySlug } from "@/lib/entitySlug";
import {
  documentDateSortKey,
  formatDocumentDate,
} from "@/lib/documentDate";
import { formatEventDate } from "@/lib/eventDate";

type TimelineDocument = Doc<"documents">;

export interface TimelineEvent {
  _id: string;
  eventDate: string;
  label: string;
  source: { _id: string; name: string; slug?: string };
  target: { _id: string; name: string; slug?: string };
  quote: string | null;
  pageNumber: number | null;
  place: string | null;
  document: { _id: string; name: string; displayName?: string } | null;
}

type Entry =
  | { kind: "document"; sortKey: string; doc: TimelineDocument }
  | { kind: "event"; sortKey: string; event: TimelineEvent };

/**
 * A project's documents and dated events in the order they happened, oldest
 * first — the chronological narrative, not the upload log. Same visual
 * grammar as the entity page's ConnectionTimeline: a left rail, year
 * sections, and undated material counted below rather than plotted, because
 * a point on a timeline is a chronology claim the document never made.
 *
 * On an equal date, documents sort before the events they describe — the
 * document is the source; its events derive from it.
 */
export function ProjectTimeline({
  documents,
  events,
  eventsCapped = false,
}: {
  documents: TimelineDocument[];
  events: TimelineEvent[];
  eventsCapped?: boolean;
}) {
  const entries: Entry[] = [];
  const undated: TimelineDocument[] = [];
  for (const doc of documents) {
    const sortKey = documentDateSortKey(doc);
    if (sortKey) entries.push({ kind: "document", sortKey, doc });
    else undated.push(doc);
  }
  let undatedEvents = 0;
  for (const event of events) {
    // The backend index already excludes undated rows; this re-check is the
    // final gate against legacy free-text dates written before the ingest
    // sanitizer existed.
    if (formatEventDate(event.eventDate)) {
      entries.push({ kind: "event", sortKey: event.eventDate, event });
    } else {
      undatedEvents += 1;
    }
  }
  entries.sort(
    (a, b) =>
      a.sortKey.localeCompare(b.sortKey) ||
      (a.kind === b.kind ? 0 : a.kind === "document" ? -1 : 1) ||
      entryName(a).localeCompare(entryName(b)),
  );

  if (documents.length === 0) {
    return (
      <EmptyState
        title="Nothing here yet"
        description="Upload documents to this project and their dates will build the timeline."
      />
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nothing carries a date yet"
        description="Dates come from each document's own text during analysis — a dateline, a stamp, a signature block. Documents that never state one stay out of the timeline rather than being guessed at."
      />
    );
  }

  const byYear = new Map<string, Entry[]>();
  for (const entry of entries) {
    const year = entry.sortKey.slice(0, 4);
    const bucket = byYear.get(year);
    if (bucket) bucket.push(entry);
    else byYear.set(year, [entry]);
  }

  return (
    <div className="flex flex-col gap-8">
      {[...byYear.entries()].map(([year, yearEntries]) => (
        <section key={year}>
          <h2 className="sticky top-0 z-10 -mx-2 mb-3 bg-background px-2 py-1 text-lg font-semibold">
            {year}
          </h2>
          <div className="flex flex-col gap-2 border-l-2 border-border pl-4">
            {yearEntries.map((entry) =>
              entry.kind === "document" ? (
                <TimelineDocumentRow key={entry.doc._id} doc={entry.doc} />
              ) : (
                <TimelineEventRow key={entry.event._id} event={entry.event} />
              ),
            )}
          </div>
        </section>
      ))}
      {eventsCapped && (
        <p className="text-xs text-muted-foreground">
          Showing the earliest dated events only — this project has more than
          the timeline loads at once.
        </p>
      )}
      {(undated.length > 0 || undatedEvents > 0) && (
        <details className="border-t border-border pt-4">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            {undated.length} undated document{undated.length !== 1 && "s"}
            {undatedEvents > 0 &&
              ` · ${undatedEvents} event${undatedEvents !== 1 ? "s" : ""} with an unreadable date`}
          </summary>
          <div className="mt-3 flex flex-col gap-2">
            {undated.map((doc) => (
              <TimelineDocumentRow key={doc._id} doc={doc} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function entryName(entry: Entry): string {
  return entry.kind === "document"
    ? entry.doc.displayName?.trim() || entry.doc.name
    : entry.event.source.name;
}

function TimelineDocumentRow({ doc }: { doc: TimelineDocument }) {
  const title = doc.displayName?.trim() || doc.name;
  return (
    <Link
      to={`/documents/${doc._id}`}
      className="group flex items-baseline gap-3 rounded-md border border-border bg-card px-3 py-2 transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
    >
      <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatDocumentDate(doc)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium group-hover:underline">
        {title}
      </span>
      <DocTypePills
        projectId={doc.projectId}
        primaryCategory={doc.primaryCategory}
        primaryKind={doc.primaryKind}
        className="hidden sm:inline-flex"
      />
    </Link>
  );
}

/** A dated fact between two entities, citing the document that asserted it. */
function TimelineEventRow({ event }: { event: TimelineEvent }) {
  const docTitle = event.document
    ? event.document.displayName?.trim() || event.document.name
    : null;
  return (
    <div className="flex items-baseline gap-3 rounded-md px-3 py-1.5">
      <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatEventDate(event.eventDate)}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p>
          <EntityLink entity={event.source} /> {event.label.toLowerCase()}{" "}
          <EntityLink entity={event.target} />
          {event.place && (
            <span className="text-muted-foreground"> · {event.place}</span>
          )}
        </p>
        {event.quote && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            “{event.quote}”
          </p>
        )}
        {event.document && (
          <Link
            to={`/documents/${event.document._id}${
              event.pageNumber !== null ? `?page=${event.pageNumber + 1}` : ""
            }`}
            className="mt-0.5 inline-block max-w-full truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {docTitle}
          </Link>
        )}
      </div>
    </div>
  );
}

function EntityLink({
  entity,
}: {
  entity: { name: string; slug?: string };
}) {
  return (
    <Link
      to={`/entity/${entity.slug ?? entitySlug(entity.name)}`}
      className="font-medium hover:underline"
    >
      {entity.name}
    </Link>
  );
}

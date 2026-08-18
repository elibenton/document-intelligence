import { Link } from "react-router";
import type { Doc } from "../../../convex/_generated/dataModel";
import { DocTypePills } from "@/components/documents/DocTypePills";
import { EmptyState } from "@/components/ui/empty-state";
import {
  documentDateSortKey,
  formatDocumentDate,
} from "@/lib/documentDate";

type TimelineDocument = Doc<"documents">;

/**
 * A project's documents in the order they were made, oldest first — the
 * chronological narrative, not the upload log. Same visual grammar as the
 * entity page's ConnectionTimeline: a left rail, year sections, and undated
 * material counted below rather than plotted, because a point on a timeline
 * is a chronology claim the document never made.
 */
export function ProjectTimeline({ documents }: { documents: TimelineDocument[] }) {
  const dated: { doc: TimelineDocument; sortKey: string }[] = [];
  const undated: TimelineDocument[] = [];
  for (const doc of documents) {
    const sortKey = documentDateSortKey(doc);
    if (sortKey) dated.push({ doc, sortKey });
    else undated.push(doc);
  }
  // Chronological, coarse-before-fine on ties (ISO prefixes already compare
  // that way), then by name so resubscribes never reorder equal rows.
  dated.sort(
    (a, b) =>
      a.sortKey.localeCompare(b.sortKey) ||
      (a.doc.displayName ?? a.doc.name).localeCompare(
        b.doc.displayName ?? b.doc.name,
      ),
  );

  if (documents.length === 0) {
    return (
      <EmptyState
        title="Nothing here yet"
        description="Upload documents to this project and their dates will build the timeline."
      />
    );
  }

  if (dated.length === 0) {
    return (
      <EmptyState
        title="No document carries a date yet"
        description="Dates come from each document's own text during analysis — a dateline, a stamp, a signature block. Documents that never state one stay out of the timeline rather than being guessed at."
      />
    );
  }

  const byYear = new Map<string, typeof dated>();
  for (const entry of dated) {
    const year = entry.sortKey.slice(0, 4);
    const bucket = byYear.get(year);
    if (bucket) bucket.push(entry);
    else byYear.set(year, [entry]);
  }

  return (
    <div className="flex flex-col gap-8">
      {[...byYear.entries()].map(([year, entries]) => (
        <section key={year}>
          <h2 className="sticky top-0 z-10 -mx-2 mb-3 bg-background px-2 py-1 text-lg font-semibold">
            {year}
          </h2>
          <div className="flex flex-col gap-2 border-l-2 border-border pl-4">
            {entries.map(({ doc }) => (
              <TimelineDocumentRow key={doc._id} doc={doc} />
            ))}
          </div>
        </section>
      ))}
      {undated.length > 0 && (
        <details className="border-t border-border pt-4">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            {undated.length} undated document{undated.length !== 1 && "s"}
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

import { Link } from "react-router";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { QuotePreview } from "@/components/entities/QuotePreview";
import { formatEventDate } from "@/lib/eventDate";

type ForEntity = FunctionReturnType<typeof api.relationships.forEntity>;
export type Connection = ForEntity["connections"][number];
export type Counterparty = ForEntity["counterparties"][number];

function ConnectionDetail({
  connection,
  subjectName,
  entityLink,
  showLabel = false,
}: {
  connection: Connection;
  subjectName: string;
  entityLink: (name: string) => string;
  showLabel?: boolean;
}) {
  const when = formatEventDate(connection.eventDate);
  return (
    <div className="border rounded-md px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        {showLabel && (
          <span className="text-muted-foreground text-xs shrink-0">
            {connection.label}
          </span>
        )}
        <Link
          to={entityLink(connection.otherEntity.name)}
          className="font-medium hover:underline truncate"
        >
          {connection.otherEntity.name}
        </Link>
        <Badge
          variant="outline"
          className="text-[10px] capitalize shrink-0"
          title={`Type: ${connection.otherEntity.type}`}
        >
          {connection.otherEntity.type}
        </Badge>
        {when && (
          <span className="text-xs text-muted-foreground ml-auto shrink-0">
            {when}
          </span>
        )}
      </div>

      {/* The document's own wording, when it differs from the canonical
          phrasing shown in the group heading — provenance the reader can check. */}
      {connection.canonicalKnown &&
        connection.relationType.replace(/_/g, " ") !== connection.label && (
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            stated as “{connection.relationType.replace(/_/g, " ")}”
          </p>
        )}

      {connection.quote && connection.document && (
        <QuotePreview
          locate={{ documentId: connection.document._id, text: connection.quote }}
          highlight={subjectName}
        >
          <p className="text-xs text-muted-foreground mt-1 italic cursor-help">
            “{connection.quote}”
          </p>
        </QuotePreview>
      )}
      {connection.quote && !connection.document && (
        <p className="text-xs text-muted-foreground mt-1 italic">
          “{connection.quote}”
        </p>
      )}
      {connection.document && (
        <Link
          to={`/documents/${connection.document._id}`}
          className="text-xs text-muted-foreground hover:underline mt-0.5 inline-block"
        >
          Source: {connection.document.name}
        </Link>
      )}
    </div>
  );
}

/**
 * Relationships grouped by what they assert, phrased from this entity's side.
 *
 * Grouping is on canonical id *and* direction: "paid" and "was paid by" are
 * opposite facts about this entity and must not merge, even though they share
 * a canonical relation.
 */
export function GroupedConnections({
  connections,
  subjectName,
  entityLink,
}: {
  connections: Connection[];
  subjectName: string;
  entityLink: (name: string) => string;
}) {
  // The query already sorted by relation strength, so insertion order into the
  // Map is the display order — no second sort needed here.
  const groups = new Map<string, { label: string; items: Connection[] }>();
  for (const connection of connections) {
    const key = `${connection.canonicalId}|${connection.direction}`;
    const existing = groups.get(key);
    if (existing) existing.items.push(connection);
    else groups.set(key, { label: connection.label, items: [connection] });
  }

  return (
    <div className="flex flex-col gap-4">
      {[...groups.entries()].map(([key, group]) => (
        <section key={key}>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
            {group.label}
            <span className="ml-1.5 normal-case tracking-normal opacity-60">
              {group.items.length}
            </span>
          </h3>
          <div className="flex flex-col gap-2">
            {group.items.map((connection) => (
              <ConnectionDetail
                key={connection._id}
                connection={connection}
                subjectName={subjectName}
                entityLink={entityLink}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The dated subset, newest first — what this entity did and when.
 *
 * Undated relationships are counted but not shown: placing them at an arbitrary
 * point on a timeline would assert a chronology the documents never stated.
 */
export function ConnectionTimeline({
  connections,
  subjectName,
  entityLink,
}: {
  connections: Connection[];
  subjectName: string;
  entityLink: (name: string) => string;
}) {
  const dated = connections
    .filter((connection) => formatEventDate(connection.eventDate))
    .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
  const undatedCount = connections.length - dated.length;

  if (dated.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No relationship carries a date yet.
        {undatedCount > 0 && ` ${undatedCount} undated.`}
      </p>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
        {dated.map((connection) => (
          <ConnectionDetail
            key={connection._id}
            connection={connection}
            subjectName={subjectName}
            entityLink={entityLink}
            showLabel
          />
        ))}
      </div>
      {undatedCount > 0 && (
        <p className="text-xs text-muted-foreground mt-2">
          {undatedCount} further relationship{undatedCount !== 1 && "s"} with no
          stated date.
        </p>
      )}
    </>
  );
}

/** Who matters around this entity, ranked by how much connects them. */
export function CounterpartyStrip({
  counterparties,
  entityLink,
}: {
  counterparties: Counterparty[];
  entityLink: (name: string) => string;
}) {
  if (counterparties.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {counterparties.map((counterparty) => (
        <Link
          key={counterparty.entity._id}
          to={entityLink(counterparty.entity.name)}
          title={counterparty.labels.join(", ")}
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="font-medium">{counterparty.entity.name}</span>
          <span className="text-muted-foreground">{counterparty.count}</span>
        </Link>
      ))}
    </div>
  );
}

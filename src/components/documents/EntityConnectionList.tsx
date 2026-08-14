import { Link } from "react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { entitySlug } from "@/lib/entitySlug";

export type DocumentConnection = FunctionReturnType<
  typeof api.relationships.byDocument
>["connections"][number];

/**
 * One connection, read from the side of the entity it is filed under.
 *
 * The subject's own name is left out — it is the row heading directly above —
 * so the line reads as a continuation of it: "Melissa Eidson / declared for
 * Department of Cannabis Control". That is the whole reason this lives under
 * the entity rather than in a list of its own, where every row had to name
 * both ends and the reader had to find the one they cared about.
 */
function ConnectionLine({
  connection,
  subjectId,
  documentId,
  index,
  projectId,
  onLocate,
}: {
  connection: DocumentConnection;
  subjectId: Id<"entities">;
  documentId: Id<"documents">;
  /** Position within this entity's list — the footnote's number. */
  index: number;
  projectId: Id<"projects"> | null;
  onLocate: (text: string, isEntity: boolean, pageNumber?: number) => void;
}) {
  const isSource = connection.source._id === subjectId;
  const other = isSource ? connection.target : connection.source;
  const label = isSource ? connection.label : connection.inverseLabel;

  // Where the supporting quote sits, so the footnote can land on it. The model
  // returns page 0 whenever it is unsure, which is most of the time, so the
  // fallback resolves the quote against the document's blocks — the same lookup
  // QuotePreview uses for its thumbnail.
  const located = useQuery(
    api.blocks.locateText,
    connection.quote && connection.pageNumber === undefined
      ? { documentId, text: connection.quote }
      : "skip"
  );
  const quotePage = connection.pageNumber ?? located?.pageNumber;

  return (
    <div className="flex items-baseline gap-1.5 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <Link
        to={`/entity/${entitySlug(other.name)}${projectId ? `?project=${projectId}` : ""}`}
        className="min-w-0 flex-1 truncate font-medium hover:underline"
        title={`Open ${other.name}`}
      >
        {other.name}
      </Link>

      {/* The claim's evidence, reduced to a citation mark. The quote and the
          date used to sit here in full, which meant three lines of prose per
          connection and a panel you had to read rather than scan. Clicking
          scrolls to the passage and highlights it in place — the document is
          the better place to read a sentence than a popup over the sidebar. */}
      {connection.quote && (
        <button
          onClick={() => onLocate(connection.quote!, false, quotePage)}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] tabular-nums text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
          title={
            quotePage === undefined
              ? "Find this passage in the document"
              : `Go to page ${quotePage + 1}`
          }
        >
          {index + 1}
        </button>
      )}
    </div>
  );
}

/**
 * Everything this document says about one entity's connections.
 *
 * Ordering comes from the query — strongest relation first, then most recent —
 * so nothing is re-sorted here.
 */
export function EntityConnectionList({
  connections,
  subjectId,
  documentId,
  projectId,
  onLocate,
}: {
  connections: DocumentConnection[];
  subjectId: Id<"entities">;
  documentId: Id<"documents">;
  projectId: Id<"projects"> | null;
  onLocate: (text: string, isEntity: boolean, pageNumber?: number) => void;
}) {
  if (connections.length === 0) {
    return (
      <p className="py-1 text-[11px] text-muted-foreground/70">
        No connections stated in this document.
      </p>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/40">
      {connections.map((connection, index) => (
        <ConnectionLine
          key={connection._id}
          connection={connection}
          subjectId={subjectId}
          documentId={documentId}
          index={index}
          projectId={projectId}
          onLocate={onLocate}
        />
      ))}
    </div>
  );
}

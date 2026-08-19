import { Link } from "react-router";
import { QuotePreview } from "@/components/entities/QuotePreview";
import type { Connection, Counterparty } from "@/components/entities/EntityConnections";
import type { Cite, Fact, FactValue, Lede, LedeClause } from "@/lib/entityBio";
import { segmentDescription } from "@/lib/entityBio";
import { formatEventDate } from "@/lib/eventDate";

/**
 * Bio-style rendering of an entity's relationships: facts stated plainly,
 * evidence behind numbered citations that preview on hover. The model these
 * render comes from buildBioModel in src/lib/entityBio.ts.
 */

/**
 * A circled-number superscript marker — the same citation format as search
 * answers (CitationButton) — hovering previews the cited page.
 */
const CITATION_CHIP =
  "mx-px inline-flex size-5 items-center justify-center rounded-full border bg-background text-2xs font-semibold leading-none text-muted-foreground transition-colors";

export function CitationMark({
  cite,
  highlight,
}: {
  cite: Cite;
  highlight: string;
}) {
  const marker = cite.documentId ? (
    <span className="align-super">
      <Link
        to={`/documents/${cite.documentId}`}
        title={cite.quote ? `“${cite.quote}”` : (cite.documentName ?? undefined)}
        className={`${CITATION_CHIP} hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      >
        {cite.n}
      </Link>
    </span>
  ) : (
    <span className="align-super">
      <span
        title={cite.quote ? `“${cite.quote}”` : undefined}
        className={CITATION_CHIP}
      >
        {cite.n}
      </span>
    </span>
  );
  if (cite.documentId && cite.quote) {
    return (
      <QuotePreview
        locate={{ documentId: cite.documentId, text: cite.quote }}
        highlight={highlight}
      >
        {marker}
      </QuotePreview>
    );
  }
  return marker;
}

function LedeValues({
  clause,
  entityLink,
  highlight,
}: {
  clause: LedeClause;
  entityLink: (name: string) => string;
  highlight: string;
}) {
  return (
    <>
      {clause.values.map((value, i) => (
        <span key={value.entity._id}>
          {i > 0 &&
          i === clause.values.length - 1 &&
          clause.overflow === 0
            ? " and "
            : i > 0
              ? ", "
              : ""}
          <Link
            to={entityLink(value.entity.name)}
            className="font-medium hover:underline"
          >
            {value.entity.name}
          </Link>
          {value.cites.map((cite) => (
            <CitationMark key={cite.n} cite={cite} highlight={highlight} />
          ))}
        </span>
      ))}
      {clause.overflow > 0 && (
        <span className="text-muted-foreground">
          {" "}
          and {clause.overflow} more
        </span>
      )}
    </>
  );
}

/**
 * The opening sentences: strongest professional facts, then personal ties.
 * Deterministically composed — every clause is a stored relationship and
 * keeps its citation, so the lede can never say more than the documents do.
 */
export function BioLede({
  lede,
  entityLink,
  highlight,
}: {
  lede: Lede;
  entityLink: (name: string) => string;
  highlight: string;
}) {
  if (lede.professional.length === 0 && lede.personal.length === 0) return null;
  const sentence = (clauses: LedeClause[]) =>
    clauses.map((clause, i) => (
      <span key={clause.label}>
        {i > 0 && "; "}
        {i === 0
          ? clause.label.charAt(0).toUpperCase() + clause.label.slice(1)
          : clause.label}{" "}
        <LedeValues
          clause={clause}
          entityLink={entityLink}
          highlight={highlight}
        />
      </span>
    ));
  return (
    <p className="max-w-prose text-base leading-relaxed">
      {lede.professional.length > 0 && <>{sentence(lede.professional)}. </>}
      {lede.personal.length > 0 && <>{sentence(lede.personal)}.</>}
    </p>
  );
}

/**
 * The AI-written lede (convex/descriptions.ts). Each sentence renders with
 * the citations of the relationship rows it was generated from, mapped to
 * the same numbers the fact rows below use — one citation space per page.
 * An entity the text names becomes a bold link to that entity's page
 * (segmentDescription's deterministic matching, no model involvement).
 */
export function GeneratedLede({
  sentences,
  citeByConnection,
  entityNames,
  entityLink,
  highlight,
}: {
  sentences: Array<{ text: string; relationshipIds: string[] }>;
  citeByConnection: Map<string, Cite>;
  entityNames: string[];
  entityLink: (name: string) => string;
  highlight: string;
}) {
  return (
    <p className="max-w-prose text-base leading-relaxed">
      {sentences.map((sentence, i) => (
        <span key={i}>
          {i > 0 && " "}
          {segmentDescription(sentence.text, entityNames).map((segment, j) =>
            segment.entityName ? (
              <Link
                key={j}
                to={entityLink(segment.entityName)}
                className="font-semibold hover:underline"
              >
                {segment.text}
              </Link>
            ) : (
              <span key={j}>{segment.text}</span>
            )
          )}
          {sentence.relationshipIds.map((id) => {
            const cite = citeByConnection.get(id);
            return cite ? (
              <CitationMark key={cite.n} cite={cite} highlight={highlight} />
            ) : null;
          })}
        </span>
      ))}
    </p>
  );
}

function FactValueItem({
  value,
  entityLink,
  highlight,
}: {
  value: FactValue;
  entityLink: (name: string) => string;
  highlight: string;
}) {
  return (
    <span>
      <Link
        to={entityLink(value.entity.name)}
        className="font-medium hover:underline"
      >
        {value.entity.name}
      </Link>
      {value.dates.length > 0 && (
        <span className="text-muted-foreground"> ({value.dates.join("; ")})</span>
      )}
      {value.cites.map((cite) => (
        <CitationMark key={cite.n} cite={cite} highlight={highlight} />
      ))}
    </span>
  );
}

/**
 * The facts as definition rows — "Owner of   Condor Club [3] · Gold Club [4]".
 * Names and dates in the open; documents and quotes behind the citations.
 */
export function FactList({
  facts,
  entityLink,
  highlight,
}: {
  facts: Fact[];
  entityLink: (name: string) => string;
  highlight: string;
}) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-6 gap-y-2.5">
      {facts.map((fact) => (
        <div key={fact.key} className="col-span-2 grid grid-cols-subgrid">
          <dt className="pt-px text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {fact.label}
          </dt>
          <dd className="min-w-0 text-sm leading-relaxed">
            {fact.values.map((value, i) => (
              <span key={value.entity._id}>
                {i > 0 && <span className="text-muted-foreground/60"> · </span>}
                <FactValueItem
                  value={value}
                  entityLink={entityLink}
                  highlight={highlight}
                />
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The dated subset, oldest first — a life in order. Undated facts are counted,
 * not placed: a timeline slot they never claimed would assert a chronology.
 */
export function BioTimeline({
  connections,
  citeByConnection,
  entityLink,
  highlight,
}: {
  connections: Connection[];
  citeByConnection: Map<string, Cite>;
  entityLink: (name: string) => string;
  highlight: string;
}) {
  const dated = connections
    .filter((c) => formatEventDate(c.eventDate))
    .sort((a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? ""));
  if (dated.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No relationship carries a date yet.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-1.5 border-l-2 border-border pl-4">
      {dated.map((c) => {
        const cite = citeByConnection.get(c._id);
        return (
          <li key={c._id} className="text-sm leading-relaxed">
            <span className="mr-2 tabular-nums text-muted-foreground">
              {formatEventDate(c.eventDate)}
            </span>
            {c.label}{" "}
            <Link
              to={entityLink(c.otherEntity.name)}
              className="font-medium hover:underline"
            >
              {c.otherEntity.name}
            </Link>
            {cite && <CitationMark cite={cite} highlight={highlight} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Ranked neighbours for the infobox — who most connects to this entity. */
export function ConnectedToList({
  counterparties,
  entityLink,
  limit = 8,
}: {
  counterparties: Counterparty[];
  entityLink: (name: string) => string;
  limit?: number;
}) {
  const shown = counterparties.slice(0, limit);
  const more = counterparties.length - shown.length;
  return (
    <ul className="flex flex-col gap-1">
      {shown.map((cp) => (
        <li
          key={cp.entity._id}
          className="flex items-baseline justify-between gap-2 text-sm"
        >
          <Link
            to={entityLink(cp.entity.name)}
            title={cp.labels.join(", ")}
            className="min-w-0 truncate hover:underline"
          >
            {cp.entity.name}
          </Link>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {cp.count}
          </span>
        </li>
      ))}
      {more > 0 && (
        <li className="text-xs text-muted-foreground">and {more} more</li>
      )}
    </ul>
  );
}

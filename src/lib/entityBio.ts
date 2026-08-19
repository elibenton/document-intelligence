import type { Id } from "../../convex/_generated/dataModel";
import type { Connection } from "@/components/entities/EntityConnections";
import { formatEventDate } from "@/lib/eventDate";

/**
 * Bio model: relationships folded into facts stated plainly, with evidence
 * demoted to numbered citations — the Wikipedia bargain of a readable
 * sentence backed by a checkable source.
 */

export interface Cite {
  n: number;
  quote: string | null;
  documentId: Id<"documents"> | null;
  documentName: string | null;
}

export interface FactValue {
  entity: Connection["otherEntity"];
  dates: string[];
  cites: Cite[];
}

export interface Fact {
  key: string;
  label: string;
  values: FactValue[];
}

export interface BioModel {
  facts: Fact[];
  /** Cite per relationship id, so the timeline reuses the same numbers. */
  citeByConnection: Map<string, Cite>;
}

export interface DescriptionSegment {
  text: string;
  /** Canonical entity name to link to, when this segment names one. */
  entityName?: string;
}

/** A name's head before an annotation separator: "BSC Management; San Francisco" → "BSC Management". */
function nameHead(name: string): string {
  return name.split(/[;(]/)[0].trim();
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Split generated description text into plain and entity-naming segments, so
 * a name the model restates renders as a link to that entity's page. Matching
 * is deterministic: case-insensitive, longest name wins at a position, and
 * only on word boundaries (so "Conti" never claims "Continental"). Entity
 * names sometimes carry an annotation tail the model rightly drops ("BSC
 * Management; San Francisco"), so the head before the separator matches too.
 */
export function segmentDescription(
  text: string,
  entityNames: string[]
): DescriptionSegment[] {
  const candidates: Array<{ match: string; name: string }> = [];
  for (const name of entityNames) {
    candidates.push({ match: name.toLowerCase(), name });
    const head = nameHead(name);
    if (head.length >= 4 && head !== name) {
      candidates.push({ match: head.toLowerCase(), name });
    }
  }
  // Longest first, so at a shared position the more specific name claims it.
  candidates.sort((a, b) => b.match.length - a.match.length);

  const lower = text.toLowerCase();
  const segments: DescriptionSegment[] = [];
  let pos = 0;
  while (pos < text.length) {
    let best: { start: number; candidate: (typeof candidates)[number] } | null =
      null;
    for (const candidate of candidates) {
      let from = pos;
      for (;;) {
        const idx = lower.indexOf(candidate.match, from);
        if (idx === -1) break;
        const bounded =
          !isWordChar(text[idx - 1]) &&
          !isWordChar(text[idx + candidate.match.length]);
        if (bounded) {
          // Strictly-earlier wins; on a tie the earlier (longer) candidate
          // already holds the slot.
          if (best === null || idx < best.start) best = { start: idx, candidate };
          break;
        }
        from = idx + 1;
      }
    }
    if (!best) break;
    if (best.start > pos) segments.push({ text: text.slice(pos, best.start) });
    segments.push({
      text: text.slice(best.start, best.start + best.candidate.match.length),
      entityName: best.candidate.name,
    });
    pos = best.start + best.candidate.match.length;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos) });
  return segments;
}

export interface LedeClause {
  label: string;
  values: FactValue[];
  /** Values beyond the cap, counted rather than listed. */
  overflow: number;
}

export interface Lede {
  professional: LedeClause[];
  personal: LedeClause[];
}

/** Relations that read as personal ties, sentenced separately from work. */
const PERSONAL_RELATIONS = new Set([
  "family_of",
  "spouse_of",
  "child_of",
  "parent_of",
  "sibling_of",
]);

const LEDE_CLAUSES = 3;
const LEDE_VALUES = 3;

/**
 * The opening sentence(s), composed deterministically from the fact rows —
 * factual by construction, so every clause keeps its citations. Facts arrive
 * strongest-first (the query's sort), and an entity already named by an
 * earlier clause is not repeated: "owner of BSC; president of BSC; founder
 * of BSC" collapses to the strongest assertion about BSC.
 */
export function buildLede(facts: Fact[]): Lede {
  const seen = new Set<string>();
  const pick = (fact: Fact): LedeClause | null => {
    const fresh = fact.values.filter((v) => !seen.has(v.entity._id));
    if (fresh.length === 0) return null;
    const values = fresh.slice(0, LEDE_VALUES);
    for (const v of values) seen.add(v.entity._id);
    return { label: fact.label, values, overflow: fresh.length - values.length };
  };

  const professionalFacts = facts.filter(
    (f) => !PERSONAL_RELATIONS.has(f.key.split("|")[0])
  );
  // Specific ties (spouse, child) before the catch-all "family of", which
  // otherwise claims the same people with less information.
  const personalFacts = facts
    .filter((f) => PERSONAL_RELATIONS.has(f.key.split("|")[0]))
    .sort(
      (a, b) =>
        Number(a.key.startsWith("family_of|")) -
        Number(b.key.startsWith("family_of|"))
    );

  const professional: LedeClause[] = [];
  for (const fact of professionalFacts) {
    if (professional.length >= LEDE_CLAUSES) break;
    const clause = pick(fact);
    if (clause) professional.push(clause);
  }
  const personal: LedeClause[] = [];
  for (const fact of personalFacts) {
    if (personal.length >= LEDE_CLAUSES) break;
    const clause = pick(fact);
    if (clause) personal.push(clause);
  }
  return { professional, personal };
}

/**
 * Fold connections into facts: one row per (canonical relation, direction),
 * one value per counterparty, every asserting document a citation on it.
 * Citation numbers are assigned in reading order, top fact first.
 */
export function buildBioModel(connections: Connection[]): BioModel {
  const facts: Fact[] = [];
  const factByKey = new Map<string, Fact>();
  const valueByEntity = new Map<string, FactValue>();
  const citeByConnection = new Map<string, Cite>();
  let n = 0;

  for (const c of connections) {
    const key = `${c.canonicalId}|${c.direction}`;
    let fact = factByKey.get(key);
    if (!fact) {
      fact = { key, label: c.label, values: [] };
      factByKey.set(key, fact);
      facts.push(fact);
    }
    const valueKey = `${key}|${c.otherEntity._id}`;
    let value = valueByEntity.get(valueKey);
    if (!value) {
      value = { entity: c.otherEntity, dates: [], cites: [] };
      valueByEntity.set(valueKey, value);
      fact.values.push(value);
    }
    const when = formatEventDate(c.eventDate);
    if (when && !value.dates.includes(when)) value.dates.push(when);

    n += 1;
    const cite: Cite = {
      n,
      quote: c.quote ?? null,
      documentId: c.document?._id ?? null,
      documentName: c.document?.name ?? null,
    };
    value.cites.push(cite);
    citeByConnection.set(c._id, cite);
  }

  return { facts, citeByConnection };
}

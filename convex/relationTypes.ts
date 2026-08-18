/**
 * The canonical relation vocabulary, and the map from what models actually say
 * onto it.
 *
 * Relationship extraction asks for "a short lowercase verb phrase", so the same
 * fact arrives as `paid`, `made_payment_to` or `payment_to` depending on the
 * run. Grouping on the raw string scatters one relationship across three
 * headings, which is exactly what makes an entity page unreadable.
 *
 * Nothing here rewrites stored data: `relationships.relationType` keeps the
 * document's own wording for provenance, and this maps it to a canonical id at
 * read time. If a mapping below turns out to be wrong, fixing it here fixes
 * every entity page immediately — no re-extraction, no lost source text.
 *
 * Pure and dependency-free on purpose: no SDK, no node, no database. It is
 * imported by convex/relationships.ts (isolate runtime) and unit-tested.
 */

export interface CanonicalRelation {
  id: string;
  /** Reads "A <label> B" — the stored source → target direction. */
  label: string;
  /** Reads "B <inverse> A". Ignored when `symmetric`. */
  inverse: string;
  /**
   * True when the relation reads identically both ways ("met with"). Direction
   * is still stored, but the UI must not invent a passive voice for it.
   */
  symmetric?: boolean;
}

/**
 * Declaration order is display order: an entity page lists its relationship
 * groups in this sequence, so the money and employment facts come before the
 * weaker associative ones. `related_to` is last because it is the catch-all.
 */
export const CANONICAL_RELATIONS: CanonicalRelation[] = [
  { id: "paid", label: "paid", inverse: "was paid by" },
  { id: "owns", label: "owns", inverse: "is owned by" },
  { id: "employed_by", label: "is employed by", inverse: "employs" },
  { id: "reports_to", label: "reports to", inverse: "manages" },
  { id: "founded", label: "founded", inverse: "was founded by" },
  { id: "represents", label: "represents", inverse: "is represented by" },
  { id: "authored", label: "authored", inverse: "was authored by" },
  { id: "member_of", label: "is a member of", inverse: "has member" },
  { id: "party_to", label: "is party to", inverse: "has party" },
  { id: "contracted_with", label: "contracted with", inverse: "", symmetric: true },
  { id: "communicated_with", label: "communicated with", inverse: "", symmetric: true },
  { id: "met_with", label: "met with", inverse: "", symmetric: true },
  { id: "family_of", label: "is family of", inverse: "", symmetric: true },
  { id: "located_in", label: "is located in", inverse: "is the location of" },
  { id: "related_to", label: "is related to", inverse: "", symmetric: true },
];

const BY_ID = new Map(CANONICAL_RELATIONS.map((r) => [r.id, r]));

/**
 * Raw verb phrase → canonical id.
 *
 * A `!` prefix means the raw phrase states the relation *backwards* relative to
 * the canonical direction: "employer_of" is `employed_by` with the endpoints
 * swapped. Recording it here rather than minting a second canonical relation is
 * what lets "X employs Y" and "Y works at X" land in one group.
 */
const ALIASES: Record<string, string> = {
  // paid
  made_payment_to: "paid",
  payment_to: "paid",
  paid_to: "paid",
  pays: "paid",
  compensated: "paid",
  reimbursed: "paid",
  invoiced: "!paid",
  received_payment_from: "!paid",
  billed: "!paid",

  // employment
  works_at: "employed_by",
  works_for: "employed_by",
  employee_of: "employed_by",
  employed_at: "employed_by",
  employed_by: "employed_by",
  employer_of: "!employed_by",
  employs: "!employed_by",
  hired: "!employed_by",
  hired_by: "employed_by",

  // ownership / control
  owner_of: "owns",
  owned_by: "!owns",
  subsidiary_of: "!owns",
  parent_of: "owns",
  acquired: "owns",
  shareholder_of: "owns",

  // hierarchy
  manages: "!reports_to",
  supervises: "!reports_to",
  supervised_by: "reports_to",
  direct_report_of: "reports_to",

  // founding
  founder_of: "founded",
  founded_by: "!founded",
  co_founded: "founded",

  // representation
  represented_by: "!represents",
  attorney_for: "represents",
  counsel_for: "represents",
  agent_for: "represents",
  acts_for: "represents",

  // authorship
  author_of: "authored",
  authored_by: "!authored",
  wrote: "authored",
  written_by: "!authored",
  signed: "authored",
  signatory_of: "authored",

  // membership
  belongs_to: "member_of",
  affiliated_with: "member_of",
  part_of: "member_of",
  director_of: "member_of",
  board_member_of: "member_of",

  // agreements
  signed_contract_with: "contracted_with",
  entered_agreement_with: "contracted_with",
  contracted: "contracted_with",
  agreement_with: "contracted_with",
  party_to_contract_with: "contracted_with",

  // contact
  emailed: "communicated_with",
  wrote_to: "communicated_with",
  called: "communicated_with",
  contacted: "communicated_with",
  corresponded_with: "communicated_with",
  spoke_with: "met_with",
  attended_meeting_with: "met_with",

  // family
  married_to: "family_of",
  spouse_of: "family_of",
  parent: "family_of",
  child_of: "family_of",
  sibling_of: "family_of",
  relative_of: "family_of",

  // place
  based_in: "located_in",
  headquartered_in: "located_in",
  resides_in: "located_in",
  situated_in: "located_in",
  location_of: "!located_in",

  // catch-all
  associated_with: "related_to",
  connected_to: "related_to",
  linked_to: "related_to",
  mentioned_with: "related_to",
};

/**
 * Reduce a raw phrase to a comparison key: lowercase, punctuation and spacing
 * collapsed to single underscores. "Made Payment To" and "made-payment-to"
 * both become `made_payment_to`.
 */
export function normalizeRelationPhrase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface CanonicalizedRelation {
  /** Canonical id, or the normalized raw phrase when unrecognized. */
  id: string;
  /** True when the raw phrase states the relation backwards — swap endpoints. */
  invert: boolean;
  /** False when this fell through to the raw phrase. */
  known: boolean;
}

/**
 * Map a stored `relationType` onto the canonical vocabulary.
 *
 * Unrecognized phrases are deliberately kept rather than forced into
 * `related_to`: a verb the map has not learned yet is still information, and
 * collapsing it would hide the very thing that tells us to extend the map.
 */
export function canonicalizeRelation(raw: string): CanonicalizedRelation {
  const key = normalizeRelationPhrase(raw);
  if (!key) return { id: "related_to", invert: false, known: true };

  if (BY_ID.has(key)) return { id: key, invert: false, known: true };

  const alias = ALIASES[key];
  if (alias) {
    const invert = alias.startsWith("!");
    return { id: invert ? alias.slice(1) : alias, invert, known: true };
  }

  return { id: key, invert: false, known: false };
}

/** Display order index; unknown relations sort after every canonical one. */
export function relationSortIndex(id: string): number {
  const index = CANONICAL_RELATIONS.findIndex((r) => r.id === id);
  return index === -1 ? CANONICAL_RELATIONS.length : index;
}

/** Turn an unrecognized phrase into something readable: "signed_over" → "signed over". */
function humanize(id: string): string {
  return id.replace(/_/g, " ");
}

/**
 * How this relation reads from one endpoint's point of view.
 *
 * `direction` is relative to the entity whose page is being rendered:
 * "outgoing" means that entity is the canonical source.
 */
export function relationLabel(
  id: string,
  direction: "outgoing" | "incoming"
): string {
  const relation = BY_ID.get(id);
  if (!relation) return humanize(id);
  if (relation.symmetric || direction === "outgoing") return relation.label;
  return relation.inverse || relation.label;
}

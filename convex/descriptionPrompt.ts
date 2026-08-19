/**
 * Prompt, response schema, and response parsing for entity descriptions —
 * pure module, no _generated imports, so it is unit-testable (the same
 * bargain as analyzePrompt.ts).
 *
 * The call this feeds is text-only: the input is the extracted fact rows,
 * never the documents, so the model cannot surface anything the extraction
 * didn't. Every sentence must name the facts it restates; parsing drops any
 * sentence whose support is missing or invented. Fact keys ("F1", "R3") are
 * assigned by the caller in sorted-row-id order, which keeps the prompt
 * byte-identical for an unchanged fact set — the vcache contract.
 */

export interface RelationshipFactInput {
  /** Prompt key, e.g. "F1". */
  key: string;
  subject: string;
  /** The document's wording, e.g. "manager_of". */
  relation: string;
  object: string;
  eventDate?: string;
  place?: string;
  quote?: string;
}

export interface RoleFactInput {
  /** Prompt key, e.g. "R1". */
  key: string;
  role: string;
  documentName?: string;
}

/** Quotes support the phrasing, but must not dominate the prompt. */
const MAX_QUOTE_CHARS = 200;

// Property order is behavior (structured output generates in declaration
// order): the model commits to its supporting facts before writing the
// sentence, not after.
export const DESCRIPTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      description:
        "One or two sentences. Each must be fully supported by the fact ids it lists.",
      items: {
        type: "object",
        properties: {
          facts: {
            type: "array",
            description:
              "Ids of the facts this sentence restates, e.g. [\"F1\", \"R3\"]. Never empty.",
            items: { type: "string" },
          },
          text: { type: "string", description: "The sentence." },
        },
        required: ["facts", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["sentences"],
  additionalProperties: false,
};

export const DESCRIPTION_SYSTEM_PROMPT = [
  "You write the opening line of a dossier profile: one or two sentences that immediately convey who an entity is, from extracted facts alone.",
  "Rules:",
  "- State only what the facts say. No inference, no outside knowledge, no speculation.",
  "- Lead with the strongest identifying facts: what they do, what they own or run, then key personal ties.",
  "- Neutral, encyclopedic tone. No praise, no judgment.",
  "- Start the first sentence with the entity's name. Do not mention documents, files, or this corpus.",
  "- In `facts`, list every fact id a sentence restates. A sentence you cannot support must not be written.",
].join("\n");

export function buildDescriptionPrompt(
  entity: { name: string; types: string[]; aliases: string[] },
  relationships: RelationshipFactInput[],
  roles: RoleFactInput[]
): string {
  const lines: string[] = [
    `ENTITY: ${entity.name} (${entity.types.join(", ") || "unknown type"})`,
  ];
  if (entity.aliases.length > 0) {
    lines.push(`ALSO KNOWN AS: ${entity.aliases.join("; ")}`);
  }
  lines.push("", "FACTS:");
  for (const r of relationships) {
    const when = r.eventDate ? ` (${r.eventDate})` : "";
    const where = r.place ? ` in ${r.place}` : "";
    const quote = r.quote
      ? ` — "${r.quote.slice(0, MAX_QUOTE_CHARS)}"`
      : "";
    lines.push(
      `${r.key} relationship: ${r.subject} ${r.relation} ${r.object}${when}${where}${quote}`
    );
  }
  for (const r of roles) {
    const source = r.documentName ? ` (asserted in: ${r.documentName})` : "";
    lines.push(`${r.key} role: ${r.role}${source}`);
  }
  return lines.join("\n");
}

export interface ParsedDescriptionSentence {
  text: string;
  relationshipKeys: string[];
  roleKeys: string[];
}

const MAX_SENTENCES = 2;

/**
 * Parse and gate the response: a sentence survives only if it cites at least
 * one fact key that actually exists in the prompt. Invalid keys are dropped
 * silently; a sentence left with none is dropped whole — the conservatism
 * rule, same as answer verification.
 */
export function parseDescriptionResponse(
  content: string,
  validRelationshipKeys: ReadonlySet<string>,
  validRoleKeys: ReadonlySet<string>
): ParsedDescriptionSentence[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const sentences =
    typeof parsed === "object" && parsed !== null && "sentences" in parsed
      ? (parsed as { sentences: unknown }).sentences
      : null;
  if (!Array.isArray(sentences)) return [];

  const out: ParsedDescriptionSentence[] = [];
  for (const s of sentences) {
    if (out.length >= MAX_SENTENCES) break;
    if (typeof s !== "object" || s === null) continue;
    const text = (s as { text?: unknown }).text;
    const facts = (s as { facts?: unknown }).facts;
    if (typeof text !== "string" || text.trim() === "") continue;
    if (!Array.isArray(facts)) continue;
    const relationshipKeys = facts.filter(
      (f): f is string => typeof f === "string" && validRelationshipKeys.has(f)
    );
    const roleKeys = facts.filter(
      (f): f is string => typeof f === "string" && validRoleKeys.has(f)
    );
    if (relationshipKeys.length === 0 && roleKeys.length === 0) continue;
    out.push({ text: text.trim(), relationshipKeys, roleKeys });
  }
  return out;
}

/**
 * Turning Analyze's extraction suggestions into an Interfaze extraction schema.
 *
 * Both ends of the app need this and they have to agree. The pipeline uses it
 * to run the initial set of extractions automatically once Analyze lands, and
 * the document page uses `extractionKey` to tell which suggestions have
 * already been run — matching on the key that ended up in `schemaUsed`. If the
 * two derived keys ever drifted, every already-run extraction would show up as
 * still pending.
 */

export interface ExtractionSuggestion {
  label: string;
  prompt: string;
  rationale?: string;
}

/** The property name a suggestion's label becomes in the extraction schema. */
export function extractionKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "_") || "extraction";
}

/**
 * One schema covering every suggestion, not one run per suggestion.
 *
 * A document may only have one extract job in flight, and a single schema with
 * several properties reads the document once instead of N times — which is
 * both the cheaper call and the only shape the job queue permits.
 *
 * Returns null when there is nothing to ask for, so callers can treat "no
 * suggestions" as "no extraction to run" without special-casing an empty
 * schema that the provider would reject.
 */
export function buildExtractionSchema(
  suggestions: ExtractionSuggestion[]
): string | null {
  const properties: Record<string, unknown> = {};
  for (const suggestion of suggestions) {
    const label = suggestion.label.trim();
    const prompt = suggestion.prompt.trim();
    if (!label || !prompt) continue;
    properties[extractionKey(label)] = {
      type: "array",
      items: { type: "string" },
      description: prompt,
    };
  }
  const keys = Object.keys(properties);
  if (keys.length === 0) return null;
  return JSON.stringify({ type: "object", properties, required: keys });
}

import type { FilterCondition } from "./types";

/**
 * "Show me every other document that shares this value."
 *
 * The Info panel already knows what a document says about itself; the Library
 * already knows how to filter on those same facts. This is the one-line join
 * between them — an Info row's field name mapped to the `PropertyDef` id that
 * answers the question in the Library.
 *
 * The mapping is the whole reason this file exists. `viewConfigValidator` in
 * convex/schema.ts stores `property` as an opaque string and the backend never
 * interprets it, so a wrong id here produces a filter that quietly matches
 * nothing — no type error, no runtime error, an empty list. metadataFilters
 * .test.ts is what turns that silent failure into a failing test.
 */
export const METADATA_FILTER_PROPERTIES = {
  author: "author",
  documentPlace: "documentPlace",
  sourceLanguageCode: "language",
  documentDate: "documentDate",
  createdDate: "createdDate",
  primaryKind: "kind",
} as const;

/** An Info-panel field that can be turned into a Library filter. */
export type MetadataFilterField = keyof typeof METADATA_FILTER_PROPERTIES;

/**
 * The filter for one shared value, or null when there is nothing to share.
 *
 * Always `is`, and always the value exactly as stored. For the two date
 * properties that reads as "falls within", because applyView compares ISO
 * prefixes with `startsWith` — so a document dated to the month filters to
 * that month rather than to an impossible exact day. Widening it is then the
 * filter bar's job, which is where the user can see what they are widening.
 */
export function metadataFilterCondition(
  field: MetadataFilterField,
  value: string | null | undefined
): FilterCondition | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return {
    property: METADATA_FILTER_PROPERTIES[field],
    operator: "is",
    value: trimmed,
  };
}

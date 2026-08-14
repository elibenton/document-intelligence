import type { Doc } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import type { PropertyDef, PropertyOption } from "./types";

/**
 * Everything the Entities list can show, group, filter, or sort by.
 *
 * The same registry shape as the Library's (documentProperties.tsx) — both
 * lists run through the same engine, so the two files are the only places
 * either list's vocabulary is defined.
 */

export type EntityRow = Doc<"entities">;

const CHIP = "text-2xs font-medium leading-none px-1.5 py-0.5 truncate";

/**
 * The stable global types. `entityTypeKey` folds the plural spellings that
 * exist in older rows onto the singular ones so a single entity kind doesn't
 * split into two groups.
 */
export const ENTITY_TYPE_LABELS: Record<string, string> = {
  person: "People",
  organization: "Organizations",
  place: "Places",
  other: "Other",
};

export function entityTypeKey(type: string): string {
  if (type === "people") return "person";
  if (type === "places") return "place";
  if (type === "dates") return "other";
  return type;
}

function observedTypes(rows: EntityRow[]): PropertyOption[] {
  const seen = new Set(rows.map((entity) => entityTypeKey(entity.type)));
  const known = Object.entries(ENTITY_TYPE_LABELS)
    .filter(([value]) => seen.has(value))
    .map(([value, label]) => ({ value, label }));
  const extra = [...seen]
    .filter((value) => !(value in ENTITY_TYPE_LABELS))
    .sort()
    .map((value) => ({ value, label: value }));
  return [...known, ...extra];
}

const countChip = (n: number, one: string, many: string) => (
  <span className="text-2xs tabular-nums text-muted-foreground shrink-0">
    {n} {n === 1 ? one : many}
  </span>
);

export const ENTITY_PROPERTIES: PropertyDef<EntityRow>[] = [
  {
    id: "name",
    label: "Name",
    kind: "text",
    pinned: true,
    searchable: true,
    sortable: true,
    filterable: true,
    value: (entity) => entity.name,
  },
  {
    id: "type",
    label: "Type",
    kind: "select",
    filterable: true,
    groupable: true,
    sortable: true,
    value: (entity) => entityTypeKey(entity.type),
    format: (entity) => {
      const key = entityTypeKey(entity.type);
      return ENTITY_TYPE_LABELS[key] ?? key;
    },
    options: observedTypes,
    render: (entity) => {
      const key = entityTypeKey(entity.type);
      return (
        <span className={cn(CHIP, "rounded-full bg-muted text-muted-foreground px-2")}>
          {ENTITY_TYPE_LABELS[key] ?? key}
        </span>
      );
    },
  },
  {
    id: "mentionCount",
    label: "Mentions",
    kind: "number",
    filterable: true,
    sortable: true,
    value: (entity) => entity.mentionCount,
    format: (entity) => `${entity.mentionCount}`,
    render: (entity) => countChip(entity.mentionCount, "mention", "mentions"),
  },
  {
    id: "documentCount",
    label: "Documents",
    kind: "number",
    filterable: true,
    sortable: true,
    value: (entity) => entity.documentCount,
    format: (entity) => `${entity.documentCount}`,
    render: (entity) => countChip(entity.documentCount, "document", "documents"),
  },
  {
    id: "avgConfidence",
    label: "Confidence",
    kind: "number",
    filterable: true,
    sortable: true,
    value: (entity) => entity.avgConfidence,
    format: (entity) => `${Math.round(entity.avgConfidence * 100)}%`,
    render: (entity) => (
      <span className="text-2xs tabular-nums text-muted-foreground shrink-0">
        {Math.round(entity.avgConfidence * 100)}%
      </span>
    ),
  },
  {
    id: "starred",
    label: "Starred",
    kind: "boolean",
    filterable: true,
    groupable: true,
    sortable: true,
    value: (entity) => entity.starred === true,
    format: (entity) => (entity.starred ? "Starred" : "Not starred"),
    options: () => [
      { value: "true", label: "Starred" },
      { value: "false", label: "Not starred" },
    ],
  },
  {
    id: "isCustom",
    label: "Added by hand",
    kind: "boolean",
    filterable: true,
    groupable: true,
    value: (entity) => entity.isCustom === true,
    format: (entity) => (entity.isCustom ? "Added by hand" : "Extracted"),
    options: () => [
      { value: "true", label: "Added by hand" },
      { value: "false", label: "Extracted" },
    ],
  },
  {
    id: "aliases",
    label: "Aliases",
    kind: "multiSelect",
    filterable: true,
    searchable: true,
    value: (entity) => entity.aliases ?? [],
    format: (entity) => (entity.aliases?.length ? entity.aliases.join(", ") : null),
    render: (entity) =>
      entity.aliases?.length ? (
        <span className={cn(CHIP, "rounded-full bg-muted text-muted-foreground px-2")}>
          {entity.aliases.join(" · ")}
        </span>
      ) : null,
  },
];

/** Reproduces the Entities list as it looked before it became configurable. */
export const DEFAULT_ENTITIES_VIEW = {
  visibleProperties: ["mentionCount"],
  groupBy: "type",
  filters: [],
  sorts: [{ property: "mentionCount", direction: "desc" as const }],
};

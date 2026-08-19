import {
  EMPTY_GROUP_KEY,
  type FilterCondition,
  type PropertyDef,
  type PropertyValue,
  type ViewConfig,
} from "./types";

/**
 * Filter, sort, and group a list of rows against a saved view config.
 *
 * Deliberately pure and free of React and Convex: the operator matrix is the
 * part most likely to be subtly wrong, and this way it can be tested directly.
 * Both lists run through this one function, so a fix to date comparison or
 * empty-value ordering lands in both at once.
 */

export interface ViewGroup<T> {
  key: string;
  label: string;
  rows: T[];
  /** The bucket for rows with no value — always sorted last. */
  isEmpty: boolean;
}

export interface ViewResult<T> {
  groups: ViewGroup<T>[];
  /** Rows surviving the filters, before grouping duplicates any of them. */
  total: number;
  /** Every row in display order, for range selection across group boundaries. */
  flat: T[];
}

function isBlank(value: PropertyValue): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function asText(value: PropertyValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.join(" ");
  return String(value);
}

const lower = (value: string) => value.trim().toLocaleLowerCase();

/**
 * Dates are ISO prefixes of varying precision ("2013", "2013-01", "2013-01-14"),
 * which compare correctly as plain strings. "is" means "falls within" rather
 * than "string-equals", so filtering a date property to "2020" matches every
 * document made that year rather than only ones dated to the bare year.
 */
function matchesDate(
  rowValue: string,
  operator: string,
  filterValue: string
): boolean {
  switch (operator) {
    case "is":
      return rowValue.startsWith(filterValue);
    case "isBefore":
      return rowValue < filterValue && !rowValue.startsWith(filterValue);
    case "isAfter":
      return rowValue > filterValue && !rowValue.startsWith(filterValue);
    case "isOnOrBefore":
      return rowValue < filterValue || rowValue.startsWith(filterValue);
    case "isOnOrAfter":
      return rowValue > filterValue || rowValue.startsWith(filterValue);
    default:
      return true;
  }
}

function matchesCondition<T>(
  row: T,
  def: PropertyDef<T>,
  condition: FilterCondition
): boolean {
  const raw = def.value(row);
  const { operator } = condition;

  if (operator === "isEmpty") return isBlank(raw);
  if (operator === "isNotEmpty") return !isBlank(raw);
  // Every remaining operator asks a question about a value the row doesn't
  // have, so a blank row fails it — including the negative ones. "Category is
  // not Legal" listing every unanalyzed document would bury the real answer.
  if (isBlank(raw)) return false;

  const many = (condition.values ?? []).map(lower).filter(Boolean);
  const one = lower(condition.value ?? "");

  switch (def.kind) {
    case "multiSelect": {
      const values = (Array.isArray(raw) ? raw : [asText(raw)]).map(lower);
      switch (operator) {
        case "containsAnyOf":
          return many.length === 0 || many.some((v) => values.includes(v));
        case "containsAllOf":
          return many.every((v) => values.includes(v));
        case "doesNotContain":
          return !many.some((v) => values.includes(v));
        default:
          return true;
      }
    }

    case "date": {
      if (!one) return true;
      return matchesDate(asText(raw), operator, condition.value!.trim());
    }

    case "number": {
      const rowNumber = Number(raw);
      const filterNumber = Number(condition.value);
      if (!Number.isFinite(rowNumber) || !Number.isFinite(filterNumber)) return true;
      switch (operator) {
        case "is":
          return rowNumber === filterNumber;
        case "ne":
          return rowNumber !== filterNumber;
        case "gt":
          return rowNumber > filterNumber;
        case "lt":
          return rowNumber < filterNumber;
        default:
          return true;
      }
    }

    case "boolean": {
      if (!one) return true;
      return String(raw) === one;
    }

    // text and select
    default: {
      const text = lower(asText(raw));
      switch (operator) {
        case "is":
          return !one || text === one;
        case "isNot":
          return !one || text !== one;
        case "contains":
          return !one || text.includes(one);
        case "notContains":
          return !one || !text.includes(one);
        case "isAnyOf":
          return many.length === 0 || many.includes(text);
        default:
          return true;
      }
    }
  }
}

/**
 * Compare two present values of one property.
 *
 * Blank handling deliberately lives in the sort loop instead, because it must
 * not be flipped by the sort direction: an absent value is not a small one.
 * Sorting undated documents as though they were ancient would bury the dated
 * ones under them ascending, and float them to the top descending.
 */
function compareValues(
  a: PropertyValue,
  b: PropertyValue,
  kind: PropertyDef<unknown>["kind"]
): number {
  if (kind === "number") return Number(a) - Number(b);
  if (kind === "boolean") return Number(b) - Number(a);
  // Dates are ISO prefixes and sort correctly as strings; a coarser date sorts
  // before any finer date inside it, which is the right answer.
  if (kind === "date") return asText(a).localeCompare(asText(b));
  return asText(a).localeCompare(asText(b), undefined, { numeric: true });
}

/** The group keys a row belongs to. Multi-select rows land in several. */
function groupKeysFor<T>(row: T, def: PropertyDef<T>): string[] {
  const raw = def.value(row);
  if (isBlank(raw)) return [EMPTY_GROUP_KEY];
  // Notion puts a multi-select row in every one of its groups, which is what
  // makes "group by tag" useful. Selection is keyed by id and deduped, so a
  // row appearing twice stays consistent when checked.
  if (Array.isArray(raw)) return raw.map((value) => String(value));
  return [String(raw)];
}

export function applyView<T>(
  rows: T[],
  defs: PropertyDef<T>[],
  config: ViewConfig,
  search = ""
): ViewResult<T> {
  const byId = new Map(defs.map((def) => [def.id, def]));

  // --- Filter --------------------------------------------------------------
  const conditions = config.filters
    .map((condition) => ({ condition, def: byId.get(condition.property) }))
    .filter(
      (entry): entry is { condition: FilterCondition; def: PropertyDef<T> } =>
        entry.def !== undefined
    );

  const needle = lower(search);
  const searchable = defs.filter((def) => def.searchable);

  const filtered = rows.filter((row) => {
    if (needle) {
      const hit = searchable.some((def) => {
        const formatted = def.format?.(row);
        const haystack = `${asText(def.value(row))} ${formatted ?? ""}`;
        return lower(haystack).includes(needle);
      });
      if (!hit) return false;
    }
    return conditions.every(({ condition, def }) =>
      matchesCondition(row, def, condition)
    );
  });

  // --- Sort ----------------------------------------------------------------
  const sorts = config.sorts
    .map((sort) => ({ sort, def: byId.get(sort.property) }))
    .filter(
      (entry): entry is { sort: (typeof config.sorts)[number]; def: PropertyDef<T> } =>
        entry.def !== undefined
    );

  const sorted = [...filtered].sort((a, b) => {
    for (const { sort, def } of sorts) {
      const aValue = def.value(a);
      const bValue = def.value(b);
      const aBlank = isBlank(aValue);
      const bBlank = isBlank(bValue);
      // Empties sink in both directions, so this verdict is returned before
      // the direction flip below ever sees it.
      if (aBlank || bBlank) {
        if (aBlank && bBlank) continue;
        return aBlank ? 1 : -1;
      }
      const result = compareValues(aValue, bValue, def.kind);
      if (result !== 0) return sort.direction === "desc" ? -result : result;
    }
    return 0;
  });

  // --- Group ---------------------------------------------------------------
  const groupDef = config.groupBy ? byId.get(config.groupBy) : undefined;
  if (!groupDef) {
    return {
      groups: [{ key: "", label: "", rows: sorted, isEmpty: false }],
      total: sorted.length,
      flat: sorted,
    };
  }

  const labels = new Map<string, string>();
  const buckets = new Map<string, T[]>();

  // Seed from the property's full option set — computed over the *unfiltered*
  // rows — so "hide empty groups" has something to hide and the bucket list
  // doesn't rearrange itself as the user filters.
  for (const option of groupDef.options?.(rows) ?? []) {
    buckets.set(option.value, []);
    labels.set(option.value, option.label);
  }

  for (const row of sorted) {
    for (const key of groupKeysFor(row, groupDef)) {
      if (!buckets.has(key)) {
        buckets.set(key, []);
        if (!labels.has(key)) {
          labels.set(key, key === EMPTY_GROUP_KEY ? "" : (groupDef.format?.(row) ?? key));
        }
      }
      buckets.get(key)!.push(row);
    }
  }

  const hideEmpty = config.hideEmptyGroups !== false;
  let groups: ViewGroup<T>[] = [...buckets.entries()]
    .map(([key, groupRows]) => ({
      key,
      label: key === EMPTY_GROUP_KEY ? "No value" : (labels.get(key) ?? key),
      rows: groupRows,
      isEmpty: key === EMPTY_GROUP_KEY,
    }))
    .filter((group) => !hideEmpty || group.rows.length > 0);

  const groupSort = config.groupSort ?? "asc";
  const manualOrder = config.groupOrder ?? [];
  groups = groups.sort((a, b) => {
    // The no-value bucket is not a value; it sits at the bottom regardless.
    if (a.isEmpty !== b.isEmpty) return a.isEmpty ? 1 : -1;
    if (groupSort === "manual") {
      // Placed groups keep the user's order; groups that appeared since the
      // last drag follow them alphabetically rather than landing at random.
      const aAt = manualOrder.indexOf(a.key);
      const bAt = manualOrder.indexOf(b.key);
      if (aAt !== -1 || bAt !== -1) {
        if (aAt === -1) return 1;
        if (bAt === -1) return -1;
        return aAt - bAt;
      }
    }
    if (groupSort === "count") return b.rows.length - a.rows.length;
    const result = a.label.localeCompare(b.label, undefined, { numeric: true });
    return groupSort === "desc" ? -result : result;
  });

  return {
    groups,
    total: sorted.length,
    flat: groups.flatMap((group) => group.rows),
  };
}

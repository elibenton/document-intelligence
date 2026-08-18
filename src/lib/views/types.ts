import type { ReactNode } from "react";

/**
 * The vocabulary both customizable lists are built on.
 *
 * A list is a set of rows plus a registry of properties describing what can be
 * read off a row. Everything the user can configure — which chips show, what
 * the rows group by, which filter operators are offered, what can be sorted —
 * is derived from that registry, so teaching a list about a new attribute is
 * one entry in one file rather than an edit in the toolbar, the row, the
 * filter, and the sort.
 *
 * Modelled on Notion's database views, minus the parts that only make sense
 * with multiple saved views and multiple layouts.
 */

export type PropertyKind =
  | "text"
  | "select"
  | "multiSelect"
  | "date"
  | "number"
  | "boolean";

/** What a property reads off a row. `null` means the row has no value for it. */
export type PropertyValue = string | number | boolean | string[] | null;

export interface PropertyOption {
  value: string;
  label: string;
}

export interface PropertyDef<T> {
  /** Stable key persisted in the saved config — renaming it orphans the config. */
  id: string;
  label: string;
  kind: PropertyKind;
  /** The comparable value, used for filtering, sorting, and grouping. */
  value: (row: T) => PropertyValue;
  /**
   * Human-readable form: group headers, filter menus, and the default chip.
   * Falls back to a plain rendering of `value` when absent.
   */
  format?: (row: T) => string | null;
  /** Custom chip, for properties that render as something other than text. */
  render?: (row: T) => ReactNode;
  /**
   * The full value set, for filter menus and for grouping into buckets that
   * exist even when nothing lands in them. Computed from the unfiltered rows
   * so the option list doesn't shrink as the user filters.
   */
  options?: (rows: T[]) => PropertyOption[];
  groupable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  /** Included in the toolbar's free-text search. */
  searchable?: boolean;
  /** Always visible — the row's identity and its link. Not hideable. */
  pinned?: boolean;
  /**
   * Render this chip flush against the named property's chip when that one is
   * immediately before it. Lets the category and kind pills read as a single
   * breadcrumb while staying independently visible, filterable, and groupable.
   */
  joinWith?: string;
  /**
   * Makes the chip editable in place wherever the page supplies a commit
   * handler (PropertyChips' `onEdit`). The registry stays React-free — this
   * only declares which control fits and what raw value it edits; the
   * mutation lives with the page.
   */
  editor?: PropertyEditor<T>;
}

export interface PropertyEditor<T> {
  control: "text" | "select" | "date";
  /** The field name handed to the page's commit handler. */
  field: string;
  /** Raw editable value (not the formatted display). Defaults to `value`. */
  read?: (row: T) => string | null;
  /** Fixed option list (languages); dynamic ones arrive via `liveOptions`. */
  staticOptions?: PropertyOption[];
  allowCustom?: boolean;
  searchable?: boolean;
}

export type FilterOperator =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "isAnyOf"
  | "containsAnyOf"
  | "containsAllOf"
  | "doesNotContain"
  | "isBefore"
  | "isAfter"
  | "isOnOrBefore"
  | "isOnOrAfter"
  | "ne"
  | "gt"
  | "lt"
  | "isEmpty"
  | "isNotEmpty";

/**
 * Which operators each kind offers. Notion's set, minus relative dates
 * ("last 30 days"), which need a clock and so can't live in a pure function.
 */
export const OPERATORS_BY_KIND: Record<PropertyKind, FilterOperator[]> = {
  text: ["contains", "notContains", "is", "isNot", "isEmpty", "isNotEmpty"],
  select: ["is", "isNot", "isAnyOf", "isEmpty", "isNotEmpty"],
  multiSelect: [
    "containsAnyOf",
    "containsAllOf",
    "doesNotContain",
    "isEmpty",
    "isNotEmpty",
  ],
  date: [
    "is",
    "isBefore",
    "isAfter",
    "isOnOrBefore",
    "isOnOrAfter",
    "isEmpty",
    "isNotEmpty",
  ],
  number: ["is", "ne", "gt", "lt", "isEmpty", "isNotEmpty"],
  boolean: ["is"],
};

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "does not contain",
  isAnyOf: "is any of",
  containsAnyOf: "contains any of",
  containsAllOf: "contains all of",
  doesNotContain: "does not contain",
  isBefore: "is before",
  isAfter: "is after",
  isOnOrBefore: "is on or before",
  isOnOrAfter: "is on or after",
  ne: "≠",
  gt: ">",
  lt: "<",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
};

/** How many values the operator's editor should collect. */
export function operatorArity(operator: FilterOperator): "none" | "one" | "many" {
  if (operator === "isEmpty" || operator === "isNotEmpty") return "none";
  if (
    operator === "isAnyOf" ||
    operator === "containsAnyOf" ||
    operator === "containsAllOf" ||
    operator === "doesNotContain"
  ) {
    return "many";
  }
  return "one";
}

export interface FilterCondition {
  property: string;
  operator: FilterOperator;
  /** Single-value operators. Always a string; the property def parses it. */
  value?: string;
  /** Multi-value operators. */
  values?: string[];
}

export interface SortDirective {
  property: string;
  direction: "asc" | "desc";
}

/** How the groups themselves are ordered. */
export type GroupSort = "asc" | "desc" | "count";

export interface ViewConfig {
  /** Ordered — this is also the left-to-right order of the chips on a row. */
  visibleProperties: string[];
  groupBy?: string;
  groupSort?: GroupSort;
  /**
   * Groups with no rows are dropped by default. Turning this off surfaces the
   * full set of buckets, which is how you see that nothing is "Government"
   * yet rather than assuming the category doesn't exist.
   */
  hideEmptyGroups?: boolean;
  filters: FilterCondition[];
  sorts: SortDirective[];
}

/** Group key for rows with no value. Underscored so it cannot collide
 *  with a real tag or kind. */
export const EMPTY_GROUP_KEY = "__empty__";

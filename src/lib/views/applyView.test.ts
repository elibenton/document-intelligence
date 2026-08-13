import { describe, expect, it } from "vitest";
import { applyView } from "./applyView";
import { EMPTY_GROUP_KEY, type PropertyDef, type ViewConfig } from "./types";

interface Row {
  id: string;
  title: string;
  category: string | null;
  tags: string[];
  date: string | null;
  pages: number | null;
  starred: boolean;
}

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  title: id,
  category: null,
  tags: [],
  date: null,
  pages: null,
  starred: false,
  ...over,
});

const DEFS: PropertyDef<Row>[] = [
  {
    id: "title",
    label: "Title",
    kind: "text",
    value: (r) => r.title,
    searchable: true,
    pinned: true,
  },
  {
    id: "category",
    label: "Category",
    kind: "select",
    value: (r) => r.category,
    options: () => [
      { value: "legal", label: "Legal" },
      { value: "government", label: "Government" },
    ],
  },
  { id: "tags", label: "Tags", kind: "multiSelect", value: (r) => r.tags },
  { id: "date", label: "Date", kind: "date", value: (r) => r.date },
  { id: "pages", label: "Pages", kind: "number", value: (r) => r.pages },
  { id: "starred", label: "Starred", kind: "boolean", value: (r) => r.starred },
];

const config = (over: Partial<ViewConfig> = {}): ViewConfig => ({
  visibleProperties: [],
  filters: [],
  sorts: [],
  ...over,
});

const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);
const only = (rows: Row[], c: ViewConfig, search?: string) =>
  ids(applyView(rows, DEFS, c, search).flat);

describe("applyView — filtering", () => {
  const rows = [
    row("a", { category: "legal", tags: ["urgent", "sf"], date: "2019-03-14", pages: 10 }),
    row("b", { category: "government", tags: ["sf"], date: "2021", pages: 3 }),
    row("c", { category: null, tags: [], date: null, pages: null }),
  ];

  it("selects on a select property", () => {
    expect(only(rows, config({ filters: [{ property: "category", operator: "is", value: "legal" }] }))).toEqual(["a"]);
  });

  it("excludes blank rows from negative operators", () => {
    // "is not legal" must not surface the row that has no category at all —
    // an unanalyzed document is not evidence of anything.
    expect(only(rows, config({ filters: [{ property: "category", operator: "isNot", value: "legal" }] }))).toEqual(["b"]);
  });

  it("handles isEmpty and isNotEmpty", () => {
    expect(only(rows, config({ filters: [{ property: "category", operator: "isEmpty" }] }))).toEqual(["c"]);
    expect(only(rows, config({ filters: [{ property: "tags", operator: "isNotEmpty" }] }))).toEqual(["a", "b"]);
  });

  it("handles isAnyOf", () => {
    expect(
      only(rows, config({ filters: [{ property: "category", operator: "isAnyOf", values: ["legal", "government"] }] }))
    ).toEqual(["a", "b"]);
  });

  it("handles multi-select operators", () => {
    const f = (operator: string, values: string[]) =>
      only(rows, config({ filters: [{ property: "tags", operator: operator as never, values }] }));
    expect(f("containsAnyOf", ["sf"])).toEqual(["a", "b"]);
    expect(f("containsAllOf", ["sf", "urgent"])).toEqual(["a"]);
    expect(f("doesNotContain", ["urgent"])).toEqual(["b"]);
  });

  it("compares dates across mixed precision", () => {
    const f = (operator: string, value: string) =>
      only(rows, config({ filters: [{ property: "date", operator: operator as never, value }] }));
    expect(f("isBefore", "2020")).toEqual(["a"]);
    expect(f("isAfter", "2020")).toEqual(["b"]);
    // "is 2019" means "falls within 2019", not "string-equals 2019".
    expect(f("is", "2019")).toEqual(["a"]);
    expect(f("isOnOrAfter", "2019-03-14")).toEqual(["a", "b"]);
    expect(f("isOnOrBefore", "2019")).toEqual(["a"]);
  });

  it("compares numbers", () => {
    const f = (operator: string, value: string) =>
      only(rows, config({ filters: [{ property: "pages", operator: operator as never, value }] }));
    expect(f("gt", "5")).toEqual(["a"]);
    expect(f("lt", "5")).toEqual(["b"]);
    expect(f("is", "3")).toEqual(["b"]);
    expect(f("ne", "3")).toEqual(["a"]);
  });

  it("ANDs every condition", () => {
    expect(
      only(
        rows,
        config({
          filters: [
            { property: "tags", operator: "containsAnyOf", values: ["sf"] },
            { property: "date", operator: "isBefore", value: "2020" },
          ],
        })
      )
    ).toEqual(["a"]);
  });

  it("applies free-text search to searchable properties only", () => {
    const named = [row("x", { title: "Roe v. SFB" }), row("y", { title: "Budget", tags: ["roe"] })];
    // "roe" is in y's tags, but tags aren't searchable — only the title is.
    expect(only(named, config(), "roe")).toEqual(["x"]);
  });

  it("ignores a filter naming a property that no longer exists", () => {
    expect(only(rows, config({ filters: [{ property: "gone", operator: "is", value: "x" }] }))).toEqual(["a", "b", "c"]);
  });
});

describe("applyView — sorting", () => {
  const rows = [
    row("a", { pages: 5, title: "Beta" }),
    row("b", { pages: null, title: "Alpha" }),
    row("c", { pages: 5, title: "Alpha" }),
    row("d", { pages: 1, title: "Zeta" }),
  ];

  it("sinks empty values to the bottom in both directions", () => {
    expect(only(rows, config({ sorts: [{ property: "pages", direction: "asc" }] }))).toEqual(["d", "a", "c", "b"]);
    expect(only(rows, config({ sorts: [{ property: "pages", direction: "desc" }] }))).toEqual(["a", "c", "d", "b"]);
  });

  it("applies sort keys in precedence order", () => {
    expect(
      only(
        rows,
        config({
          sorts: [
            { property: "pages", direction: "desc" },
            { property: "title", direction: "asc" },
          ],
        })
      )
    ).toEqual(["c", "a", "d", "b"]);
  });

  it("sorts dates chronologically across precisions", () => {
    const dated = [
      row("y2013", { date: "2013" }),
      row("m201306", { date: "2013-06" }),
      row("d20130104", { date: "2013-01-04" }),
    ];
    expect(only(dated, config({ sorts: [{ property: "date", direction: "asc" }] }))).toEqual([
      "y2013",
      "d20130104",
      "m201306",
    ]);
  });
});

describe("applyView — grouping", () => {
  const rows = [
    row("a", { category: "legal", tags: ["sf", "urgent"] }),
    row("b", { category: "legal", tags: ["sf"] }),
    row("c", { category: null }),
  ];

  it("returns one unlabelled group when ungrouped", () => {
    const result = applyView(rows, DEFS, config());
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].label).toBe("");
  });

  it("buckets by value and puts the no-value group last", () => {
    const result = applyView(rows, DEFS, config({ groupBy: "category" }));
    expect(result.groups.map((g) => [g.label, ids(g.rows)])).toEqual([
      ["Legal", ["a", "b"]],
      ["No value", ["c"]],
    ]);
  });

  it("hides empty option groups by default and reveals them when asked", () => {
    expect(applyView(rows, DEFS, config({ groupBy: "category" })).groups.map((g) => g.label)).not.toContain(
      "Government"
    );
    const shown = applyView(rows, DEFS, config({ groupBy: "category", hideEmptyGroups: false }));
    expect(shown.groups.map((g) => g.label)).toContain("Government");
  });

  it("puts a multi-select row in every one of its groups", () => {
    const result = applyView(rows, DEFS, config({ groupBy: "tags" }));
    const sf = result.groups.find((g) => g.key === "sf");
    const urgent = result.groups.find((g) => g.key === "urgent");
    expect(ids(sf!.rows)).toEqual(["a", "b"]);
    expect(ids(urgent!.rows)).toEqual(["a"]);
    // `total` counts rows, not appearances — `flat` is the display order and
    // does contain the duplicate.
    expect(result.total).toBe(3);
  });

  it("orders groups by count when asked", () => {
    const result = applyView(rows, DEFS, config({ groupBy: "tags", groupSort: "count" }));
    expect(result.groups.map((g) => g.key)).toEqual(["sf", "urgent", EMPTY_GROUP_KEY]);
  });

  it("sorts within groups, not just across them", () => {
    const unsorted = [
      row("a", { category: "legal", pages: 9 }),
      row("b", { category: "legal", pages: 2 }),
    ];
    const result = applyView(
      unsorted,
      DEFS,
      config({ groupBy: "category", sorts: [{ property: "pages", direction: "asc" }] })
    );
    expect(ids(result.groups[0].rows)).toEqual(["b", "a"]);
  });

  it("flattens in display order for range selection", () => {
    const result = applyView(rows, DEFS, config({ groupBy: "category" }));
    expect(ids(result.flat)).toEqual(["a", "b", "c"]);
  });
});

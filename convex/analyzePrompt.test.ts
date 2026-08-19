import { describe, expect, it } from "vitest";
import {
  buildAnalyzePrompt,
  buildDocumentUnderstandingSchema,
} from "./analyzePrompt";

const CATEGORIES = [
  { key: "legal", label: "Legal", description: "Court filings." },
];

function prompt(omit?: {
  tableOfContents?: boolean;
  displayTitle?: boolean;
  author?: boolean;
}) {
  return buildAnalyzePrompt({
    csv: false,
    kindNames: ["letter"],
    categories: CATEGORIES,
    fileName: "a.pdf",
    graphExtraTypes: [],
    omit,
  });
}

describe("native metadata omissions", () => {
  // The prompt and schema are vcache inputs: an empty omission set must be
  // byte-identical to no omission set, or every existing document's re-run
  // silently stops hitting the cache.
  it("an empty omit changes nothing, byte for byte", () => {
    expect(prompt({})).toBe(prompt());
    expect(
      JSON.stringify(buildDocumentUnderstandingSchema(["legal"], [], {}))
    ).toBe(JSON.stringify(buildDocumentUnderstandingSchema(["legal"], [])));
  });

  it("omitting the toc removes only the toc sentence, both leads", () => {
    const without = prompt({ tableOfContents: true });
    expect(without).not.toContain("Build the table of contents");
    expect(without).toContain("Flag any page ranges");
    const fileLead = buildAnalyzePrompt({
      csv: false,
      kindNames: [],
      categories: CATEGORIES,
      fileInput: true,
      omit: { tableOfContents: true },
    });
    expect(fileLead).not.toContain("Build the table of contents");
    expect(fileLead).toContain("Flag any page ranges");
  });

  it("omitting the title removes the title rule", () => {
    const without = prompt({ displayTitle: true });
    expect(without).not.toContain("display_title");
    expect(without).toContain("primary_kind");
  });

  it("omitting the author removes the contributors clause", () => {
    const without = prompt({ author: true });
    expect(without).not.toContain("`contributors`");
    expect(without).toContain("`container_title`");
  });

  it("omits schema fields without reordering the survivors", () => {
    const full = buildDocumentUnderstandingSchema(["legal"], ["vessel"]);
    const omitted = buildDocumentUnderstandingSchema(["legal"], ["vessel"], {
      tableOfContents: true,
      displayTitle: true,
      author: true,
    });
    const dropped = new Set(["table_of_contents", "display_title", "title", "author"]);
    expect(Object.keys(omitted.properties)).toEqual(
      Object.keys(full.properties).filter((key) => !dropped.has(key))
    );
    expect(omitted.required).not.toContain("table_of_contents");
    expect(omitted.required).not.toContain("title");
    expect(omitted.required).not.toContain("author");
    // The graph still rides along untouched.
    expect(omitted.required).toContain("entities");
    const properties = omitted.properties as Record<string, unknown>;
    const citation = properties.citation as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(citation.properties)).not.toContain("contributors");
    expect(citation.required).toEqual(["type"]);
  });

  // askCreatedDate is the same vcache bargain: off (or undefined) must be
  // byte-identical to the world before the flag existed, and on must only
  // APPEND — created_date lands after citation, before the graph, so the
  // reasoning chain the declaration order encodes is untouched.
  it("askCreatedDate off is byte-identical; on appends after citation", () => {
    expect(
      buildAnalyzePrompt({
        csv: false,
        kindNames: ["letter"],
        categories: CATEGORIES,
        fileName: "a.pdf",
        graphExtraTypes: [],
        askCreatedDate: false,
      })
    ).toBe(prompt());
    expect(
      JSON.stringify(
        buildDocumentUnderstandingSchema(["legal"], [], undefined, false, false)
      )
    ).toBe(JSON.stringify(buildDocumentUnderstandingSchema(["legal"], [])));

    const withAsk = buildDocumentUnderstandingSchema(
      ["legal"],
      ["vessel"],
      undefined,
      false,
      true
    );
    const keys = Object.keys(withAsk.properties);
    expect(keys.indexOf("created_date")).toBe(keys.indexOf("citation") + 1);
    expect(keys.indexOf("entities")).toBeGreaterThan(
      keys.indexOf("created_date")
    );
    const without = buildDocumentUnderstandingSchema(["legal"], ["vessel"]);
    expect(keys.filter((key) => key !== "created_date")).toEqual(
      Object.keys(without.properties)
    );
    // Declining must stay legal: never required.
    expect(withAsk.required).not.toContain("created_date");
    const asked = buildAnalyzePrompt({
      csv: false,
      kindNames: ["letter"],
      categories: CATEGORIES,
      fileName: "a.pdf",
      graphExtraTypes: [],
      askCreatedDate: true,
    });
    expect(asked).toContain("created_date");
    expect(asked).not.toBe(prompt());
  });

  it("repeated builds never share mutated state", () => {
    buildDocumentUnderstandingSchema(["legal"], [], {
      tableOfContents: true,
      displayTitle: true,
      author: true,
    });
    const full = buildDocumentUnderstandingSchema(["legal"], []);
    expect(Object.keys(full.properties)).toContain("table_of_contents");
    expect(Object.keys(full.properties)).toContain("display_title");
  });
});

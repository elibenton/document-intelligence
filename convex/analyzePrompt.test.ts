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

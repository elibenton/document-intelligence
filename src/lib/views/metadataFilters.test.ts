import { describe, expect, it } from "vitest";
import {
  METADATA_FILTER_PROPERTIES,
  metadataFilterCondition,
  type MetadataFilterField,
} from "./metadataFilters";
import { DOCUMENT_PROPERTIES } from "./documentProperties";
import { OPERATORS_BY_KIND } from "./types";

const fields = Object.keys(METADATA_FILTER_PROPERTIES) as MetadataFilterField[];

describe("metadata filter mapping", () => {
  // The point of the whole file: a property id that does not exist produces a
  // filter matching nothing, silently. These two cases are the only thing
  // standing between a typo and an empty Library.
  it.each(fields)("%s maps to a real library property", (field) => {
    const id = METADATA_FILTER_PROPERTIES[field];
    expect(DOCUMENT_PROPERTIES.map((p) => p.id)).toContain(id);
  });

  it.each(fields)("%s maps to a filterable property offering `is`", (field) => {
    const id = METADATA_FILTER_PROPERTIES[field];
    const def = DOCUMENT_PROPERTIES.find((p) => p.id === id)!;
    expect(def.filterable).toBe(true);
    expect(OPERATORS_BY_KIND[def.kind]).toContain("is");
  });
});

describe("metadataFilterCondition", () => {
  it("builds an `is` condition on the mapped property", () => {
    expect(metadataFilterCondition("author", "Charles Kessler")).toEqual({
      property: "author",
      operator: "is",
      value: "Charles Kessler",
    });
  });

  it("maps the language field onto the `language` property, not its raw name", () => {
    expect(metadataFilterCondition("sourceLanguageCode", "fr")?.property).toBe(
      "language"
    );
  });

  it("keeps a partial date at its own precision", () => {
    expect(metadataFilterCondition("documentDate", "2019-03")?.value).toBe(
      "2019-03"
    );
  });

  it("trims surrounding whitespace", () => {
    expect(metadataFilterCondition("documentPlace", "  Geneva  ")?.value).toBe(
      "Geneva"
    );
  });

  it("returns null for a value the document does not state", () => {
    expect(metadataFilterCondition("author", null)).toBeNull();
    expect(metadataFilterCondition("author", undefined)).toBeNull();
    expect(metadataFilterCondition("author", "")).toBeNull();
    expect(metadataFilterCondition("author", "   ")).toBeNull();
  });
});

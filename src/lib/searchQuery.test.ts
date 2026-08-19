import { describe, expect, it } from "vitest";
import {
  parseQuery,
  serializeQuery,
  serializeTerm,
} from "./searchQuery";

describe("parseQuery", () => {
  it("returns bare text untouched", () => {
    expect(parseQuery("smith declaration 2023")).toEqual({
      text: "smith declaration 2023",
      terms: [],
    });
  });

  it("extracts a single term", () => {
    const parsed = parseQuery("kind:memo");
    expect(parsed.text).toBe("");
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.terms[0]).toMatchObject({
      prefix: "kind",
      value: "memo",
      raw: "kind:memo",
      start: 0,
      end: 9,
    });
  });

  it("handles quoted values with spaces", () => {
    const parsed = parseQuery('kind:"tax form" refund');
    expect(parsed.terms[0]).toMatchObject({ prefix: "kind", value: "tax form" });
    expect(parsed.text).toBe("refund");
  });

  it("normalizes curly quotes", () => {
    const parsed = parseQuery("kind:“tax form” refund");
    expect(parsed.terms[0]).toMatchObject({ prefix: "kind", value: "tax form" });
    expect(parsed.text).toBe("refund");
  });

  it("leaves unknown prefixes in the text", () => {
    const parsed = parseQuery("Re: Smith kind:memo");
    expect(parsed.text).toBe("Re: Smith");
    expect(parsed.terms).toHaveLength(1);
  });

  it("keeps a colon-bearing title intact when no prefix matches", () => {
    expect(parseQuery("note to self: buy milk").text).toBe(
      "note to self: buy milk",
    );
  });

  it("treats note: as a term but self: as text", () => {
    const parsed = parseQuery("note:important self:aware");
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.terms[0].prefix).toBe("note");
    expect(parsed.text).toBe("self:aware");
  });

  it("resolves aliases to canonical prefixes", () => {
    expect(parseQuery("in:deposition").terms[0].prefix).toBe("doc");
  });

  it("parses an incomplete trailing term with empty value", () => {
    const parsed = parseQuery("refund kind:");
    expect(parsed.terms[0]).toMatchObject({ prefix: "kind", value: "" });
    expect(parsed.text).toBe("refund");
  });

  it("handles multiple terms of the same prefix", () => {
    const parsed = parseQuery("tag:urgent tag:2023");
    expect(parsed.terms.map((t) => t.value)).toEqual(["urgent", "2023"]);
  });

  it("preserves interleaved text order", () => {
    const parsed = parseQuery("smith kind:memo refund date:2023");
    expect(parsed.text).toBe("smith refund");
    expect(parsed.terms.map((t) => t.prefix)).toEqual(["kind", "date"]);
  });

  it("is case-insensitive on the prefix", () => {
    expect(parseQuery("Kind:memo").terms[0].prefix).toBe("kind");
  });
});


describe("serialization", () => {
  it("quotes only when needed", () => {
    expect(serializeTerm("kind", "memo")).toBe("kind:memo");
    expect(serializeTerm("kind", "tax form")).toBe('kind:"tax form"');
    expect(serializeTerm("kind", "")).toBe('kind:""');
  });

  it("round-trips canonically", () => {
    const canonical = 'kind:"tax form" date:2023 refund smith';
    expect(serializeQuery(parseQuery(canonical))).toBe(canonical);
  });

  it("is stable after one normalization pass", () => {
    const messy = "refund   kind:“tax form”  smith";
    const once = serializeQuery(parseQuery(messy));
    expect(serializeQuery(parseQuery(once))).toBe(once);
  });
});

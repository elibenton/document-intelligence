import { describe, expect, it } from "vitest";
import {
  CANONICAL_RELATIONS,
  canonicalizeRelation,
  normalizeRelationPhrase,
  relationLabel,
  relationSortIndex,
} from "./relationTypes";

describe("normalizeRelationPhrase", () => {
  it("collapses case, spacing and punctuation to one key", () => {
    const key = "made_payment_to";
    expect(normalizeRelationPhrase("Made Payment To")).toBe(key);
    expect(normalizeRelationPhrase("made-payment-to")).toBe(key);
    expect(normalizeRelationPhrase("  made   payment  to  ")).toBe(key);
    expect(normalizeRelationPhrase("made_payment_to")).toBe(key);
  });

  it("strips leading and trailing separators", () => {
    expect(normalizeRelationPhrase("__paid__")).toBe("paid");
    expect(normalizeRelationPhrase("!!!")).toBe("");
  });
});

describe("canonicalizeRelation", () => {
  it("passes a canonical id through untouched", () => {
    expect(canonicalizeRelation("paid")).toEqual({
      id: "paid",
      invert: false,
      known: true,
    });
  });

  it("folds the variants that motivated this map onto one id", () => {
    for (const phrase of ["made_payment_to", "payment_to", "paid_to", "pays"]) {
      expect(canonicalizeRelation(phrase).id).toBe("paid");
      expect(canonicalizeRelation(phrase).invert).toBe(false);
    }
  });

  it("marks backwards phrasings for endpoint swapping", () => {
    // "X employs Y" is the same fact as "Y is employed by X".
    expect(canonicalizeRelation("employs")).toEqual({
      id: "employed_by",
      invert: true,
      known: true,
    });
    expect(canonicalizeRelation("works_at")).toEqual({
      id: "employed_by",
      invert: false,
      known: true,
    });
  });

  it("keeps an unrecognized phrase instead of forcing it into related_to", () => {
    // A verb the map has not learned is still information, and preserving it is
    // what surfaces the need to extend the map.
    expect(canonicalizeRelation("subpoenaed")).toEqual({
      id: "subpoenaed",
      invert: false,
      known: false,
    });
  });

  it("treats an empty phrase as the generic relation", () => {
    expect(canonicalizeRelation("")).toEqual({
      id: "related_to",
      invert: false,
      known: true,
    });
    expect(canonicalizeRelation("   ").id).toBe("related_to");
  });

  it("every alias resolves to a declared canonical relation", () => {
    // Guards against a typo in the alias table silently minting a bogus group.
    const ids = new Set(CANONICAL_RELATIONS.map((r) => r.id));
    const phrases = [
      "works_at", "employer_of", "invoiced", "owned_by", "subsidiary_of",
      "manages", "founded_by", "represented_by", "authored_by", "belongs_to",
      "signed_contract_with", "emailed", "married_to", "based_in",
      "location_of", "associated_with", "acquired", "counsel_for",
    ];
    for (const phrase of phrases) {
      const result = canonicalizeRelation(phrase);
      expect(result.known, `${phrase} should be a known alias`).toBe(true);
      expect(ids.has(result.id), `${phrase} -> ${result.id}`).toBe(true);
    }
  });
});

describe("relationLabel", () => {
  it("reads actively from the source and passively from the target", () => {
    expect(relationLabel("paid", "outgoing")).toBe("paid");
    expect(relationLabel("paid", "incoming")).toBe("was paid by");
  });

  it("uses one phrasing for symmetric relations", () => {
    expect(relationLabel("met_with", "outgoing")).toBe("met with");
    expect(relationLabel("met_with", "incoming")).toBe("met with");
  });

  it("humanizes an unrecognized id rather than showing raw underscores", () => {
    expect(relationLabel("signed_over_to", "outgoing")).toBe("signed over to");
  });

  it("gives every canonical relation a non-empty label in both directions", () => {
    for (const relation of CANONICAL_RELATIONS) {
      expect(relationLabel(relation.id, "outgoing")).toBeTruthy();
      expect(relationLabel(relation.id, "incoming")).toBeTruthy();
    }
  });
});

describe("relationSortIndex", () => {
  it("orders money and employment ahead of the catch-all", () => {
    expect(relationSortIndex("paid")).toBeLessThan(relationSortIndex("related_to"));
    expect(relationSortIndex("employed_by")).toBeLessThan(
      relationSortIndex("related_to")
    );
  });

  it("sorts unknown relations after every canonical one", () => {
    expect(relationSortIndex("subpoenaed")).toBe(CANONICAL_RELATIONS.length);
  });
});

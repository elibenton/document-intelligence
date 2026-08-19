import { describe, expect, it } from "vitest";
import { buildBioModel, buildLede, segmentDescription } from "./entityBio";
import type { Connection } from "@/components/entities/EntityConnections";

let nextId = 0;
function conn(
  overrides: Partial<Connection> & {
    canonicalId: string;
    label: string;
    otherName: string;
  }
): Connection {
  nextId += 1;
  const { otherName, ...rest } = overrides;
  return {
    _id: `rel${nextId}`,
    direction: "outgoing",
    canonicalKnown: true,
    relationType: rest.canonicalId,
    confidence: 0.9,
    quote: "quoted text",
    pageNumber: 0,
    eventDate: undefined,
    otherEntity: { _id: `ent-${otherName}`, name: otherName, type: "organization" },
    document: { _id: `doc${nextId}`, name: `doc ${nextId}` },
    ...rest,
  } as Connection;
}

describe("buildBioModel", () => {
  it("folds repeat assertions into one value with stacked citations", () => {
    const model = buildBioModel([
      conn({ canonicalId: "owns", label: "owns", otherName: "Gold Club" }),
      conn({ canonicalId: "owns", label: "owns", otherName: "Gold Club" }),
      conn({ canonicalId: "owns", label: "owns", otherName: "Condor Club" }),
    ]);
    expect(model.facts).toHaveLength(1);
    expect(model.facts[0].values.map((v) => v.entity.name)).toEqual([
      "Gold Club",
      "Condor Club",
    ]);
    expect(model.facts[0].values[0].cites.map((c) => c.n)).toEqual([1, 2]);
    expect(model.citeByConnection.size).toBe(3);
  });

  it("keeps the two directions of one relation as separate facts", () => {
    const model = buildBioModel([
      conn({ canonicalId: "paid", label: "paid", otherName: "A" }),
      conn({
        canonicalId: "paid",
        label: "was paid by",
        otherName: "B",
        direction: "incoming",
      }),
    ]);
    expect(model.facts.map((f) => f.label)).toEqual(["paid", "was paid by"]);
  });
});

describe("buildLede", () => {
  it("splits professional from personal and never repeats an entity", () => {
    const { facts } = buildBioModel([
      conn({ canonicalId: "owns", label: "owns", otherName: "Gold Club" }),
      conn({ canonicalId: "owns", label: "owns", otherName: "Condor Club" }),
      conn({
        canonicalId: "president_of",
        label: "president of",
        otherName: "BSC Management",
      }),
      // Same counterparty under a weaker relation: must not re-appear.
      conn({
        canonicalId: "founder_of",
        label: "founder of",
        otherName: "BSC Management",
      }),
      conn({
        canonicalId: "spouse_of",
        label: "spouse of",
        otherName: "Alexandra Lutnick",
      }),
      conn({
        canonicalId: "family_of",
        label: "is family of",
        otherName: "Alexandra Lutnick",
        direction: "incoming",
      }),
      conn({
        canonicalId: "family_of",
        label: "is family of",
        otherName: "Habib Carouba",
        direction: "incoming",
      }),
    ]);
    const lede = buildLede(facts);
    expect(
      lede.professional.map((c) => [c.label, c.values.map((v) => v.entity.name)])
    ).toEqual([
      ["owns", ["Gold Club", "Condor Club"]],
      ["president of", ["BSC Management"]],
    ]);
    // spouse_of outranks the catch-all family_of for the same person, and
    // family_of keeps only who is left.
    expect(
      lede.personal.map((c) => [c.label, c.values.map((v) => v.entity.name)])
    ).toEqual([
      ["spouse of", ["Alexandra Lutnick"]],
      ["is family of", ["Habib Carouba"]],
    ]);
  });

  it("caps values per clause and counts the overflow", () => {
    const { facts } = buildBioModel(
      ["A", "B", "C", "D", "E"].map((name) =>
        conn({ canonicalId: "owns", label: "owns", otherName: name })
      )
    );
    const lede = buildLede(facts);
    expect(lede.professional[0].values).toHaveLength(3);
    expect(lede.professional[0].overflow).toBe(2);
  });
});

describe("segmentDescription", () => {
  const names = [
    "BSC Management; San Francisco",
    "Gold Club - S.F., LLC",
    "GOLD CLUB",
    "Alexandra Lutnick",
    "Sam Conti",
  ];

  it("links restated names, matching annotation-stripped heads case-insensitively", () => {
    const segments = segmentDescription(
      "Joe Carouba is the president of BSC Management and husband of Alexandra Lutnick.",
      names
    );
    expect(segments).toEqual([
      { text: "Joe Carouba is the president of " },
      { text: "BSC Management", entityName: "BSC Management; San Francisco" },
      { text: " and husband of " },
      { text: "Alexandra Lutnick", entityName: "Alexandra Lutnick" },
      { text: "." },
    ]);
  });

  it("prefers the longest name at a position", () => {
    const segments = segmentDescription(
      "He manages Gold Club - S.F., LLC directly.",
      names
    );
    expect(segments[1]).toEqual({
      text: "Gold Club - S.F., LLC",
      entityName: "Gold Club - S.F., LLC",
    });
  });

  it("only matches on word boundaries", () => {
    const segments = segmentDescription(
      "The Continental partnership with Sam Conti endured.",
      names
    );
    expect(segments).toEqual([
      { text: "The Continental partnership with " },
      { text: "Sam Conti", entityName: "Sam Conti" },
      { text: " endured." },
    ]);
  });

  it("returns the whole text as one plain segment when nothing matches", () => {
    expect(segmentDescription("Nothing to see here.", names)).toEqual([
      { text: "Nothing to see here." },
    ]);
  });
});

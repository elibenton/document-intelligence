import { describe, expect, it } from "vitest";
import {
  buildDescriptionPrompt,
  parseDescriptionResponse,
} from "./descriptionPrompt";

const ENTITY = { name: "Joe Carouba", types: ["person"], aliases: ["Joseph H. Carouba"] };
const RELS = [
  {
    key: "F1",
    subject: "Joe Carouba",
    relation: "owner_of",
    object: "Condor Club",
    quote: "Its current owner, Joseph Carouba",
  },
  {
    key: "F2",
    subject: "Joe Carouba",
    relation: "spouse_of",
    object: "Alexandra Lutnick",
    eventDate: "2024-12-02",
  },
];
const ROLES = [{ key: "R1", role: "president", documentName: "SF Chronicle clip" }];

describe("buildDescriptionPrompt", () => {
  it("is deterministic for the same fact set — the vcache contract", () => {
    const a = buildDescriptionPrompt(ENTITY, RELS, ROLES);
    const b = buildDescriptionPrompt(ENTITY, RELS, ROLES);
    expect(a).toBe(b);
    expect(a).toContain("F1 relationship: Joe Carouba owner_of Condor Club");
    expect(a).toContain("F2 relationship: Joe Carouba spouse_of Alexandra Lutnick (2024-12-02)");
    expect(a).toContain("R1 role: president (asserted in: SF Chronicle clip)");
    expect(a).toContain("ALSO KNOWN AS: Joseph H. Carouba");
  });

  it("clips long quotes rather than letting them dominate the prompt", () => {
    const prompt = buildDescriptionPrompt(
      ENTITY,
      [{ ...RELS[0], quote: "x".repeat(500) }],
      []
    );
    expect(prompt).not.toContain("x".repeat(201));
  });
});

describe("parseDescriptionResponse", () => {
  const relKeys = new Set(["F1", "F2"]);
  const roleKeys = new Set(["R1"]);

  it("keeps supported sentences and separates fact kinds", () => {
    const out = parseDescriptionResponse(
      JSON.stringify({
        sentences: [
          { facts: ["F1", "R1"], text: "Joe Carouba owns the Condor Club." },
        ],
      }),
      relKeys,
      roleKeys
    );
    expect(out).toEqual([
      {
        text: "Joe Carouba owns the Condor Club.",
        relationshipKeys: ["F1"],
        roleKeys: ["R1"],
      },
    ]);
  });

  it("drops a sentence whose only support is invented", () => {
    const out = parseDescriptionResponse(
      JSON.stringify({
        sentences: [
          { facts: ["F9"], text: "He was a senator." },
          { facts: [], text: "Uncited claim." },
          { facts: ["F2"], text: "He is married to Alexandra Lutnick." },
        ],
      }),
      relKeys,
      roleKeys
    );
    expect(out.map((s) => s.text)).toEqual(["He is married to Alexandra Lutnick."]);
  });

  it("caps at two sentences and survives malformed output", () => {
    const many = parseDescriptionResponse(
      JSON.stringify({
        sentences: [1, 2, 3, 4].map((n) => ({ facts: ["F1"], text: `S${n}.` })),
      }),
      relKeys,
      roleKeys
    );
    expect(many).toHaveLength(2);
    expect(parseDescriptionResponse("not json", relKeys, roleKeys)).toEqual([]);
    expect(parseDescriptionResponse("{}", relKeys, roleKeys)).toEqual([]);
  });
});

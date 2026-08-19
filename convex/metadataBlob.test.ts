import { describe, expect, it } from "vitest";
import { mergeMetadataBlob } from "./metadataBlob";

describe("mergeMetadataBlob", () => {
  const clipBlob = JSON.stringify({
    title: "The Real Headline",
    summary: "og description",
    date: "2024-05-01",
    author: "Jane Byline",
    language: "en",
    additional: [
      { key: "site", value: "The Atlantic" },
      { key: "excerpt", value: "First paragraph…" },
      { key: "source url", value: "https://example.com/a" },
    ],
  });

  it("overlays only the keys the model answered", () => {
    const merged = JSON.parse(
      mergeMetadataBlob(clipBlob, { summary: "model summary", author: "" })
    );
    expect(merged.summary).toBe("model summary");
    expect(merged.author).toBe("Jane Byline"); // empty answer doesn't displace
    expect(merged.title).toBe("The Real Headline");
    expect(merged.date).toBe("2024-05-01");
  });

  it("keeps every ingest additional entry, existing winning collisions", () => {
    const merged = JSON.parse(
      mergeMetadataBlob(clipBlob, {
        additional: [
          { key: "Site", value: "model's site guess" },
          { key: "issuer", value: "ACME Corp" },
        ],
      })
    );
    expect(merged.additional).toEqual([
      { key: "site", value: "The Atlantic" },
      { key: "excerpt", value: "First paragraph…" },
      { key: "source url", value: "https://example.com/a" },
      { key: "issuer", value: "ACME Corp" },
    ]);
  });

  it("drops empty or keyless additional entries from the model", () => {
    const merged = JSON.parse(
      mergeMetadataBlob(undefined, {
        additional: [
          { key: "", value: "x" },
          { key: "k", value: "" },
          { key: "kept", value: "v" },
        ],
      })
    );
    expect(merged.additional).toEqual([{ key: "kept", value: "v" }]);
  });

  it("tolerates a garbage or absent existing blob", () => {
    expect(JSON.parse(mergeMetadataBlob("not json", { title: "T" }))).toEqual({
      title: "T",
      additional: [],
    });
    expect(JSON.parse(mergeMetadataBlob(undefined, {}))).toEqual({
      additional: [],
    });
    expect(JSON.parse(mergeMetadataBlob('["array"]', { title: "T" })).title).toBe(
      "T"
    );
  });
});

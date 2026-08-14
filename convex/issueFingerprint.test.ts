import { describe, expect, it } from "vitest";
import {
  issueFingerprint,
  normalizeMessage,
  sampleText,
  scrub,
} from "./issueFingerprint";

/** The shape every fingerprint call uses, so the tests vary one thing at a time. */
function fp(over: {
  surface?: string;
  stage?: string;
  errorCode?: string;
  fileKind?: string;
  message: string;
}) {
  return issueFingerprint({
    surface: over.surface ?? "pipeline",
    stage: over.stage ?? "parse",
    errorCode: over.errorCode,
    fileKind: over.fileKind,
    normalized: normalizeMessage(over.message),
  });
}

describe("scrub", () => {
  it("removes the parts that name a user's file or request", () => {
    expect(
      scrub(
        'Failed to parse "Smith v. Jones.pdf" (k17459c0gfmnejsavanan8gbg18cfxrg) ' +
          "from https://files.convex.cloud/abc?token=xyz after 3 attempts"
      )
    ).toBe("Failed to parse <name> (<id>) from <url> after <n> attempts");
  });

  it("catches a UUID and a curly-quoted name", () => {
    expect(
      scrub("job 3f7c1b2a-9d4e-4a1b-8c2d-5e6f7a8b9c0d for “Deposition”")
    ).toBe("job <id> for <name>");
  });

  it("leaves a message with nothing identifying untouched", () => {
    expect(scrub("Interfaze rejected the request: insufficient credits")).toBe(
      "Interfaze rejected the request: insufficient credits"
    );
  });
});

describe("issueFingerprint", () => {
  it("groups the same defect across different documents", () => {
    expect(
      fp({
        message:
          'Failed to parse "Smith v. Jones.pdf" (k17459c0gfmnejsavanan8gbg18cfxrg): 504',
      })
    ).toBe(
      fp({
        message:
          'Failed to parse "Q3 budget.pdf" (jd72m1p4qz9wxbe6hs03ntv85ycra1gk): 504',
      })
    );
  });

  it("groups across signed storage URLs, which differ every request", () => {
    expect(
      fp({ message: "timeout fetching https://x.convex.cloud/a?sig=111" })
    ).toBe(fp({ message: "timeout fetching https://x.convex.cloud/b?sig=222" }));
  });

  it("separates different stages", () => {
    const message = "the provider returned an empty response";
    expect(fp({ stage: "parse", message })).not.toBe(
      fp({ stage: "analyze", message })
    );
  });

  it("separates different error codes on identical prose", () => {
    const message = "Upload failed.";
    expect(fp({ errorCode: "invalid_pdf", message })).not.toBe(
      fp({ errorCode: "password_protected", message })
    );
  });

  it("separates different surfaces and file kinds", () => {
    const message = "Upload failed.";
    expect(fp({ surface: "client", message })).not.toBe(
      fp({ surface: "pipeline", message })
    );
    expect(fp({ fileKind: "pdf", message })).not.toBe(
      fp({ fileKind: "audio", message })
    );
  });

  it("ignores trailing detail past the title cutoff", () => {
    const head = "provider error: ";
    expect(fp({ message: head + "a".repeat(400) })).toBe(
      fp({ message: head + "a".repeat(300) })
    );
  });
});

describe("sampleText", () => {
  it("keeps more prose than the title but is still scrubbed", () => {
    const long = `rejected "${"x".repeat(400)}.pdf" because of the size limit`;
    const sample = sampleText(long);
    expect(sample).toBe("rejected <name> because of the size limit");
    expect(sample).not.toContain("xxx");
  });

  it("caps at the sample length", () => {
    expect(sampleText("y".repeat(500))).toHaveLength(300);
  });
});

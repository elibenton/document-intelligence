import { describe, expect, it } from "vitest";
import { cleanPdfAuthor, cleanPdfTitle } from "./pdfNativeMetadata";

describe("cleanPdfTitle", () => {
  it("keeps a real stated title", () => {
    expect(cleanPdfTitle("Quarterly Compliance Review", "scan_0042.pdf")).toBe(
      "Quarterly Compliance Review"
    );
  });

  it("collapses whitespace", () => {
    expect(cleanPdfTitle("  Annual\n Report ", "a.pdf")).toBe("Annual Report");
  });

  it("drops authoring-tool residue", () => {
    for (const junk of [
      "Microsoft Word - draft3.docx",
      "Untitled",
      "Untitled document",
      "PowerPoint Presentation",
      "Document",
      "final-v2.docx",
      "Scanned Document",
      "",
      "ab",
    ]) {
      expect(cleanPdfTitle(junk, "upload.pdf")).toBeUndefined();
    }
  });

  it("drops a title that restates the filename", () => {
    expect(cleanPdfTitle("Q3 memo", "q3 memo.pdf")).toBeUndefined();
    expect(cleanPdfTitle("Q3 Memo", "Q3 MEMO")).toBeUndefined();
  });

  it("tolerates non-string input", () => {
    expect(cleanPdfTitle(undefined, "a.pdf")).toBeUndefined();
    expect(cleanPdfTitle(42, "a.pdf")).toBeUndefined();
  });
});

describe("cleanPdfAuthor", () => {
  it("keeps a credited person or body", () => {
    expect(cleanPdfAuthor("Jane Q. Investigator")).toBe("Jane Q. Investigator");
    expect(cleanPdfAuthor("Office of the Inspector General")).toBe(
      "Office of the Inspector General"
    );
  });

  it("drops logins and software credits", () => {
    for (const junk of ["user", "Admin", "unknown", "Adobe Acrobat", "Microsoft Office Word", "", "j"]) {
      expect(cleanPdfAuthor(junk)).toBeUndefined();
    }
  });
});

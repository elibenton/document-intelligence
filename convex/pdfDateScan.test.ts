import { describe, expect, it } from "vitest";
import { scanPdfCreationDate } from "./pdfDateScan";

const encode = (text: string) => new TextEncoder().encode(text);

describe("scanPdfCreationDate", () => {
  it("finds a literal /CreationDate", () => {
    expect(
      scanPdfCreationDate(
        encode("<< /Producer (x) /CreationDate (D:20190314102201+02'00') >>")
      )
    ).toBe("D:20190314102201+02'00'");
  });

  it("finds a hex-string /CreationDate", () => {
    const hex = [..."D:20190314"]
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");
    expect(scanPdfCreationDate(encode(`/CreationDate <${hex}>`))).toBe(
      "D:20190314"
    );
  });

  it("finds XMP CreateDate in attribute and element form", () => {
    expect(
      scanPdfCreationDate(encode('<rdf:Description xmp:CreateDate="2019-03-14T10:22:01Z"/>'))
    ).toBe("2019-03-14T10:22:01Z");
    expect(
      scanPdfCreationDate(
        encode("<xmp:CreateDate> 2019-03-14T10:22:01Z </xmp:CreateDate>")
      )
    ).toBe("2019-03-14T10:22:01Z");
  });

  it("prefers the Info dictionary over XMP", () => {
    expect(
      scanPdfCreationDate(
        encode('xmp:CreateDate="2001-01-01" /CreationDate (D:2019)')
      )
    ).toBe("D:2019");
  });

  it("returns null when nothing scannable exists", () => {
    expect(scanPdfCreationDate(encode("%PDF-1.7 compressed stream"))).toBeNull();
    expect(scanPdfCreationDate(new Uint8Array(0))).toBeNull();
  });
});

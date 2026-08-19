/**
 * Backfill-only, best-effort scan for a stored PDF's creation date.
 *
 * The forward path parses PDFs properly (pdfjs in the browser reads the Info
 * dictionary and XMP); the backfill has only raw bytes in a Convex action, so
 * it scans for the two forms that are plain text by construction: the XMP
 * packet (the XMP spec requires it be scannable as text) and an uncompressed
 * Info dictionary's /CreationDate. Object-stream-compressed Info dicts and
 * encrypted PDFs yield null — an accepted loss.
 *
 * Returns the raw stated date ("D:2019..." or ISO); callers finish with
 * pdfDateToIso / sanitizeNativeDate from nativeDate.ts.
 */
export function scanPdfCreationDate(bytes: Uint8Array): string | null {
  try {
    // latin1 maps bytes 1:1 so ASCII markers survive whatever surrounds them.
    const text = new TextDecoder("latin1").decode(bytes);

    const literal = /\/CreationDate\s*\(\s*(D:[^)\\]{4,26})\s*\)/.exec(text);
    if (literal) return literal[1];

    const hex = /\/CreationDate\s*<([0-9A-Fa-f\s]{8,60})>/.exec(text);
    if (hex) {
      const decoded = hex[1]
        .replace(/\s+/g, "")
        .replace(/[0-9a-fA-F]{2}/g, (pair) =>
          String.fromCharCode(parseInt(pair, 16))
        );
      if (decoded.startsWith("D:")) return decoded;
    }

    const xmpAttribute = /xmp:CreateDate\s*=\s*"([^"]{4,40})"/.exec(text);
    if (xmpAttribute) return xmpAttribute[1];

    const xmpElement = /<xmp:CreateDate>\s*([^<\s][^<]{2,38})\s*<\/xmp:CreateDate>/.exec(
      text
    );
    if (xmpElement) return xmpElement[1].trim();

    return null;
  } catch {
    return null;
  }
}

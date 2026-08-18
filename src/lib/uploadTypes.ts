/**
 * What the upload surfaces actually accept.
 *
 * This is the client-side mirror of `detectMediaType` in convex/upload.ts.
 * Keep the two in sync: anything accepted here must map to a media type the
 * pipeline knows how to process, or the document lands in a stuck/failed
 * state with no useful explanation.
 */

const ACCEPTED_MIME_PREFIXES = ["image/", "audio/", "video/"];
const ACCEPTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "application/csv",
];

/** Extensions for the file picker's `accept` attribute. */
export const ACCEPT_ATTR =
  ".pdf,.csv,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.mp3,.m4a,.wav,.aac,.ogg,.flac,.mp4,.mov,.webm,.mkv";

/** Fallback for browsers/OSes that hand over an empty `file.type`. */
const ACCEPTED_EXTENSIONS = new Set(
  ACCEPT_ATTR.split(",").map((e) => e.replace(".", ""))
);

export function isSupportedUpload(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (ACCEPTED_MIME_TYPES.includes(mime)) return true;
  if (ACCEPTED_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  // Empty or bogus MIME type — fall back to the extension.
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ext !== "" && ACCEPTED_EXTENSIONS.has(ext);
}

/** Human-readable reason shown on the rejected upload row. */
export const UNSUPPORTED_REASON =
  "Unsupported file type — upload a PDF, DOCX, CSV, image, audio, or video file. Web pages are captured with the browser clipper.";

export function isCsvDocument(doc: {
  mediaType?: string;
  mimeType?: string;
  name?: string;
}): boolean {
  const mime = doc.mimeType?.toLowerCase() ?? "";
  return (
    doc.mediaType === "csv" ||
    mime === "text/csv" ||
    mime === "application/csv" ||
    doc.name?.toLowerCase().endsWith(".csv") === true
  );
}

/**
 * Media-type predicates shared across runtimes. A leaf module — no Convex
 * imports, no "use node" — so the browser can import it the same way it
 * imports interfazeLimits.ts, and the pipeline, the prompt builder, and the
 * upload UI cannot disagree about what a CSV is.
 */

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

/**
 * Audio and video, which the pipeline transcribes rather than OCRs. The check
 * was written out at three call sites before this existed; a fourth would have
 * been the one to disagree.
 */
export function isRecordingDocument(doc: { mediaType?: string }): boolean {
  return doc.mediaType === "audio" || doc.mediaType === "video";
}

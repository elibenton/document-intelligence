import { isCsvDocument } from "@/lib/uploadTypes";

/**
 * Medium predicates and labels for the processing pipeline. Kept out of
 * DocStatusIndicator.tsx so that file exports only its component — mixing
 * component and value exports breaks React Fast Refresh for the module.
 */
export function isAudioVideo(doc: {
  mediaType?: string;
  mimeType?: string;
}): boolean {
  if (doc.mediaType === "audio" || doc.mediaType === "video") return true;
  return (
    !!doc.mimeType &&
    (doc.mimeType.startsWith("audio/") || doc.mimeType.startsWith("video/"))
  );
}

/**
 * The four words the library is allowed to say about a document.
 *
 * Everything the pipeline is doing collapses to Scanning → Analyzing →
 * Extracting, and then the row goes quiet. A document that has finished says
 * nothing at all: the library is a list of documents, not a progress board,
 * and a permanent badge on every finished row is noise.
 */
export type LibraryStatus = "Scanning" | "Analyzing" | "Extracting" | "Failed";

export function libraryStatus(doc: {
  status: string;
  mediaType?: string;
  mimeType?: string;
  metadata?: string;
  /** The analyze job's status, from documents.list. */
  analyzeStatus?: string | null;
}): LibraryStatus | null {
  if (doc.status === "failed") return "Failed";
  if (doc.status === "extracting") return "Extracting";
  // Queued and scanning are the same fact to a reader: the text isn't out yet.
  if (doc.status === "uploaded" || doc.status === "parsing") return "Scanning";
  if (doc.status !== "parsed") return null;

  // "parsed" is the window between the scan landing and extraction starting,
  // which is exactly Analyze's window. Recordings included: they run Analyze
  // over their mirrored transcript like any other document.
  if (doc.analyzeStatus === "failed") return "Failed";
  // Analyze's output is what marks it finished. Once it lands, extraction is
  // already scheduled, so the row goes quiet for the moment in between rather
  // than inventing a fifth word for it.
  return doc.metadata === undefined ? "Analyzing" : null;
}

/** Medium-specific label for the parse stage. */
export function parseStageLabel(
  doc: { mediaType?: string; mimeType?: string },
  form: "noun" | "verb" = "noun"
): string {
  if (isAudioVideo(doc)) {
    return form === "verb" ? "Transcribing" : "Transcribe";
  }
  if (doc.mediaType === "webScrape") {
    return form === "verb" ? "Scraping" : "Scrape";
  }
  if (isCsvDocument(doc)) {
    return form === "verb" ? "Parsing" : "Parse";
  }
  return "OCR";
}

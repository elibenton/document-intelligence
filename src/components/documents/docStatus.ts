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

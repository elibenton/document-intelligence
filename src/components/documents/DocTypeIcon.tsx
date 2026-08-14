import { FileText, Film, Globe, Image, Mic, Table } from "lucide-react";
import { cn } from "@/lib/utils";

const SPREADSHEET_MIMES = new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

type DocTypeKind = "spreadsheet" | "image" | "audio" | "video" | "web" | "file";

function docTypeKind(doc: { mediaType?: string; mimeType?: string }): DocTypeKind {
  const mime = doc.mimeType ?? "";
  switch (doc.mediaType) {
    case "csv":
      return "spreadsheet";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "webScrape":
      return "web";
  }
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "text/html") return "web";
  if (SPREADSHEET_MIMES.has(mime)) return "spreadsheet";
  return "file";
}

/** Media-type icon for a document: PDF, image, audio, video, web clip, … */
export function DocTypeIcon({
  mediaType,
  mimeType,
  className,
}: {
  mediaType?: string;
  mimeType?: string;
  className?: string;
}) {
  // Each branch names its icon statically. Resolving to a component variable
  // and rendering <Icon /> would read shorter but makes the element type
  // dynamic, which defeats React's ability to keep the node across renders.
  const cls = cn("size-3.5 shrink-0 text-muted-foreground", className);
  switch (docTypeKind({ mediaType, mimeType })) {
    case "spreadsheet":
      return <Table className={cls} />;
    case "image":
      return <Image className={cls} />;
    case "audio":
      return <Mic className={cls} />;
    case "video":
      return <Film className={cls} />;
    case "web":
      return <Globe className={cls} />;
    case "file":
      return <FileText className={cls} />;
  }
}

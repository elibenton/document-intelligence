import {
  FileText,
  Film,
  Globe,
  Image,
  Mic,
  Table,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const SPREADSHEET_MIMES = new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function docTypeIcon(doc: {
  mediaType?: string;
  mimeType?: string;
}): LucideIcon {
  const mime = doc.mimeType ?? "";
  switch (doc.mediaType) {
    case "csv":
      return Table;
    case "image":
      return Image;
    case "audio":
      return Mic;
    case "video":
      return Film;
    case "webScrape":
      return Globe;
  }
  if (mime.startsWith("image/")) return Image;
  if (mime.startsWith("audio/")) return Mic;
  if (mime.startsWith("video/")) return Film;
  if (mime === "text/html") return Globe;
  if (SPREADSHEET_MIMES.has(mime)) return Table;
  return FileText;
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
  const Icon = docTypeIcon({ mediaType, mimeType });
  return (
    <Icon
      className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", className)}
    />
  );
}

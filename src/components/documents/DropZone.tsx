import { useRef, useState } from "react";
import {
  FileText,
  Image,
  Mic,
  Film,
  Table,
  UploadCloud,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useUpload, type UploadItem } from "@/hooks/useUpload";
import { ACCEPT_ATTR } from "@/lib/uploadTypes";
import type { Id } from "../../../convex/_generated/dataModel";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

// Only what the pipeline can actually process (see src/lib/uploadTypes.ts and
// detectMediaType in convex/upload.ts). Web pages arrive through the browser
// clipper rather than a file drop.
const SUPPORTED_TYPES = [
  { icon: FileText, label: "PDFs" },
  { icon: Table, label: "CSVs" },
  { icon: Image, label: "Images" },
  { icon: Mic, label: "Audio" },
  { icon: Film, label: "Video" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DropZone({ projectId }: { projectId: Id<"projects"> }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload, isUploading, uploads } = useUpload(projectId);
  const [isDragging, setIsDragging] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    // Upload in parallel so multi-file drops all show progress at once
    await Promise.all(Array.from(files).map((file) => upload(file)));
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
        className={`cursor-pointer rounded-xl border-2 border-dashed px-8 py-10 text-center transition-colors ${
          isDragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-accent/30"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        {isUploading ? (
          <Spinner className="mx-auto mb-3 h-8 w-8 text-primary" />
        ) : (
          <UploadCloud className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        )}
        <p className="text-lg font-semibold">
          {isUploading ? "Uploading..." : "Drop files to analyze"}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          Store and parse PDFs and CSVs, OCR images, transcribe recordings,
          extract entities, and uncover connections.
        </p>
        <div className="flex flex-wrap justify-center gap-2 mt-4">
          {SUPPORTED_TYPES.map((t) => (
            <span
              key={t.label}
              className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground"
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </span>
          ))}
        </div>
      </div>

      {uploads.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {uploads.map((item) => (
            <UploadRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

export function UploadRow({ item }: { item: UploadItem }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {item.status === "done" ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        ) : item.status === "error" ? (
          <AlertCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        ) : (
          <Spinner className="h-4 w-4 shrink-0 text-primary" />
        )}
        {item.status === "done" && item.documentId ? (
          <Link
            to={`/documents/${item.documentId}`}
            className="text-sm truncate flex-1 hover:underline"
          >
            {item.name}
          </Link>
        ) : (
          <span className="text-sm truncate flex-1">{item.name}</span>
        )}
        <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
          {item.status === "preflighting"
            ? "Checking file…"
            : item.status === "converting"
              ? `Optimizing audio… ${item.progress}%`
            : item.status === "uploading"
              ? `${item.progress}% of ${formatBytes(item.size)}`
            : item.status === "finalizing"
              ? "Starting analysis…"
              : item.status === "done"
                ? "Processing started"
                : "Failed"}
        </span>
      </div>
      {(item.status === "converting" ||
        item.status === "uploading" ||
        item.status === "finalizing") && (
        <Progress
          className="h-1"
          value={item.status === "finalizing" ? undefined : item.progress}
        />
      )}
      {item.status === "error" && item.error && (
        <p className="text-xs text-red-600 dark:text-red-400">{item.error}</p>
      )}
      {item.status !== "error" && item.detail && (
        <p className="text-xs text-muted-foreground">{item.detail}</p>
      )}
    </div>
  );
}

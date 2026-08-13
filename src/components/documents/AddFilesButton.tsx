import { useRef } from "react";
import { Upload } from "lucide-react";
import { useUploads } from "@/hooks/uploadContext";
import { uploadWithConcurrency } from "@/lib/uploadQueue";
import { ACCEPT_ATTR } from "@/lib/uploadTypes";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * The click-to-browse path. Dragging and pasting are the primary ways in — the
 * drop surface only appears while a drag is over the window — so keyboard and
 * mouse users still need a way to reach the file picker.
 */
export function AddFilesButton({ projectId }: { projectId: Id<"projects"> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { upload } = useUploads();

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) {
            void uploadWithConcurrency(files, (file) =>
              upload(file, projectId)
            );
          }
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Upload className="h-3.5 w-3.5" />
        Add files
      </button>
    </>
  );
}

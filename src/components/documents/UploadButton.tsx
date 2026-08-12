import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useUpload } from "@/hooks/useUpload";
import { ACCEPT_ATTR } from "@/lib/uploadTypes";
import type { Id } from "../../../convex/_generated/dataModel";

export function UploadButton({ projectId }: { projectId: Id<"projects"> }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload, isUploading, uploads } = useUpload(projectId);
  const latestNotice = uploads.at(-1);
  const isConverting = latestNotice?.status === "converting";

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;

    // No local allowlist: `upload` validates and surfaces a reason. The old
    // inline filter silently discarded anything outside pdf/png/jpeg — no
    // error, no row, no feedback at all.
    for (const file of Array.from(files)) {
      await upload(file);
    }

    // Reset input so the same file can be uploaded again
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
      <Button
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        size="sm"
      >
        {isUploading ? (
          <span className="flex items-center gap-1.5">
            <Spinner className="h-3.5 w-3.5" />
            {isConverting
              ? `Optimizing… ${latestNotice.progress}%`
              : "Uploading…"}
          </span>
        ) : (
          "Upload"
        )}
      </Button>
      {latestNotice?.status === "error" && latestNotice.error && (
        <span className="max-w-80 text-right text-xs text-red-600 dark:text-red-400">
          {latestNotice.error}
        </span>
      )}
      {latestNotice?.status !== "error" && latestNotice?.detail && (
        <span className="max-w-80 text-right text-xs text-muted-foreground">
          {latestNotice.detail}
        </span>
      )}
    </div>
  );
}

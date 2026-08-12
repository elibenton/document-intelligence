import { useCallback, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { isSupportedUpload, UNSUPPORTED_REASON } from "@/lib/uploadTypes";
import { isAudioUpload, preflightAudio } from "@/lib/audioPreflight";
import { isPdfUpload, preflightPdf } from "@/lib/pdfPreflight";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  /** 0-100 upload progress (bytes sent to storage) */
  progress: number;
  status:
    | "preflighting"
    | "converting"
    | "uploading"
    | "finalizing"
    | "done"
    | "error";
  error?: string;
  detail?: string;
  documentId?: Id<"documents">;
}

let nextUploadId = 0;

/** Upload a file with progress events (fetch can't report upload progress). */
function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void
): Promise<{ storageId: Id<"_storage"> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("Unexpected response from storage"));
        }
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

export function useUpload(projectId: Id<"projects">) {
  const generateUploadUrl = useMutation(api.upload.generateUploadUrl);
  const createDocument = useMutation(api.upload.createDocument);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const timersRef = useRef<number[]>([]);

  const patchUpload = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...patch } : u))
    );
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const upload = useCallback(
    async (file: File) => {
      const id = `upload-${nextUploadId++}`;
      setUploads((prev) => [
        ...prev,
        {
          id,
          name: file.name,
          size: file.size,
          progress: 0,
          status: "preflighting",
        },
      ]);

      // Validate here rather than at each call site: the drop zone took
      // anything at all, and the backend then defaulted unknown types to
      // "pdf" and sent e.g. a spreadsheet down the PDF parse path.
      if (!isSupportedUpload(file)) {
        patchUpload(id, { status: "error", error: UNSUPPORTED_REASON });
        timersRef.current.push(window.setTimeout(() => removeUpload(id), 8000));
        return undefined;
      }

      try {
        let uploadFile = file;
        if (isPdfUpload(file)) {
          patchUpload(id, { detail: "Inspecting PDF structure…" });
          const preflight = await preflightPdf(file);
          if (!preflight.ok) {
            patchUpload(id, { status: "error", error: preflight.message });
            timersRef.current.push(
              window.setTimeout(() => removeUpload(id), 12_000)
            );
            return undefined;
          }
          patchUpload(id, { detail: preflight.message });
        } else if (isAudioUpload(file)) {
          const preflight = await preflightAudio(file);
          if (!preflight.ok) {
            patchUpload(id, { status: "error", error: preflight.message });
            timersRef.current.push(
              window.setTimeout(() => removeUpload(id), 12_000)
            );
            return undefined;
          }
          patchUpload(id, { detail: preflight.message });
          if (preflight.action === "convert") {
            patchUpload(id, { status: "converting", progress: 0 });
            const { optimizeAudioForUpload } = await import(
              "@/lib/audioConverter"
            );
            uploadFile = await optimizeAudioForUpload(file, {
              onProgress: (percent) => patchUpload(id, { progress: percent }),
            });
            patchUpload(id, {
              name: uploadFile.name,
              size: uploadFile.size,
              detail: `${preflight.message} · optimized to ${(
                uploadFile.size / 1_000_000
              ).toFixed(1)} MB WebM/Opus`,
            });
          }
        }

        patchUpload(id, { status: "uploading", progress: 0 });
        const url = await generateUploadUrl();
        const { storageId } = await uploadWithProgress(
          url,
          uploadFile,
          (percent) => patchUpload(id, { progress: percent })
        );
        patchUpload(id, { progress: 100, status: "finalizing" });
        const documentId = await createDocument({
          projectId,
          name: uploadFile.name,
          storageId,
          mimeType: uploadFile.type,
        });
        patchUpload(id, { status: "done", documentId });
        // Keep the completed row briefly so the user sees it land, then clear
        timersRef.current.push(
          window.setTimeout(() => removeUpload(id), 4000)
        );
        return documentId;
      } catch (e) {
        patchUpload(id, {
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        timersRef.current.push(
          window.setTimeout(() => removeUpload(id), 8000)
        );
        return undefined;
      }
    },
    [generateUploadUrl, createDocument, patchUpload, removeUpload, projectId]
  );

  const isUploading = uploads.some(
    (u) =>
      u.status === "preflighting" ||
      u.status === "converting" ||
      u.status === "uploading" ||
      u.status === "finalizing"
  );

  return { upload, isUploading, uploads, removeUpload };
}

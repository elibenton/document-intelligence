import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { UploadContext, type UploadItem } from "@/hooks/uploadContext";
import { isSupportedUpload, UNSUPPORTED_REASON } from "@/lib/uploadTypes";
import { isAudioUpload, preflightAudio } from "@/lib/audioPreflight";
import { isPdfUpload, preflightPdf } from "@/lib/pdfPreflight";

let nextUploadId = 0;

/** How long a finished card lingers before the document joins the library. */
const DONE_LINGER_MS = 2500;
const ERROR_LINGER_MS = 8000;

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

/**
 * Owns every upload in the app. This is a provider rather than a per-component
 * hook because two surfaces need the same list: the drop overlay renders it,
 * and the library has to know which documents it must *not* show yet.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const generateUploadUrl = useMutation(api.upload.generateUploadUrl);
  const createDocument = useMutation(api.upload.createDocument);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const patchUpload = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...patch } : u))
    );
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const upload = useCallback(
    async (file: File, projectId: Id<"projects">) => {
      const id = `upload-${nextUploadId++}`;
      setUploads((prev) => [
        ...prev,
        {
          id,
          projectId,
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
        timersRef.current.push(
          window.setTimeout(() => removeUpload(id), ERROR_LINGER_MS)
        );
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
          patchUpload(id, {
            detail: preflight.message,
            warnings: preflight.warnings.map((warning) => warning.message),
          });
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
        // Not "done": the bytes have landed but the pipeline hasn't run. The
        // card holds the file until `ingestStates` reports a terminal status.
        patchUpload(id, {
          status: "ingesting",
          stage: "uploaded",
          documentId,
        });
        return documentId;
      } catch (e) {
        patchUpload(id, {
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        timersRef.current.push(
          window.setTimeout(() => removeUpload(id), ERROR_LINGER_MS)
        );
        return undefined;
      }
    },
    [generateUploadUrl, createDocument, patchUpload, removeUpload]
  );

  // Watch the documents still being held. The args are derived from a joined
  // string so the subscription is not re-created on every unrelated patch to
  // the uploads array.
  const ingestingKey = uploads
    .filter((u) => u.status === "ingesting" && u.documentId)
    .map((u) => u.documentId)
    .join(",");
  const ingestArgs = useMemo(
    () =>
      ingestingKey === ""
        ? ("skip" as const)
        : { ids: ingestingKey.split(",") as Id<"documents">[] },
    [ingestingKey]
  );
  const states = useQuery(api.documents.ingestStates, ingestArgs);

  const finalizedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!states) return;

    const byId = new Map(states.map((state) => [state._id, state]));
    setUploads((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (item.status !== "ingesting" || !item.documentId) return item;
        const state = byId.get(item.documentId);
        if (!state) return item;
        if (state.status === "completed" || state.status === "missing") {
          changed = true;
          return { ...item, status: "done" as const, stage: undefined };
        }
        if (state.status === "failed") {
          changed = true;
          return {
            ...item,
            status: "error" as const,
            error: state.errorMessage ?? "Processing failed.",
          };
        }
        if (state.status === item.stage) return item;
        changed = true;
        return { ...item, stage: state.status };
      });
      return changed ? next : prev;
    });

    // Release the document to the library a beat after it settles, so the card
    // is seen finishing rather than vanishing. Guarded by a ref: a re-run
    // before the state patch lands would otherwise queue the timer twice.
    for (const state of states) {
      const terminal =
        state.status === "completed" ||
        state.status === "failed" ||
        state.status === "missing";
      if (!terminal || finalizedRef.current.has(state._id)) continue;
      finalizedRef.current.add(state._id);
      const delay =
        state.status === "failed" ? ERROR_LINGER_MS : DONE_LINGER_MS;
      timersRef.current.push(
        window.setTimeout(
          () =>
            setUploads((prev) =>
              prev.filter((u) => u.documentId !== state._id)
            ),
          delay
        )
      );
    }
  }, [states]);

  const heldDocumentIds = useMemo(() => {
    const held = new Set<Id<"documents">>();
    for (const item of uploads) {
      if (item.documentId) held.add(item.documentId);
    }
    return held;
  }, [uploads]);

  const value = useMemo(
    () => ({ uploads, upload, heldDocumentIds }),
    [uploads, upload, heldDocumentIds]
  );

  return (
    <UploadContext.Provider value={value}>{children}</UploadContext.Provider>
  );
}

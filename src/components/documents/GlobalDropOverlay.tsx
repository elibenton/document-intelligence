import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { AlertCircle, UploadCloud, X } from "lucide-react";
import { useLocation } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useUpload } from "@/hooks/useUpload";
import { UploadRow } from "@/components/documents/DropZone";

function routeSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length).split("/")[0];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        // Chromium returns directory contents in batches, commonly 100 at a
        // time, so keep reading until it returns an empty batch.
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function filesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return [await fileFromEntry(entry as FileSystemFileEntry)];
  }
  if (entry.isDirectory) {
    const children = await readDirectoryEntries(
      (entry as FileSystemDirectoryEntry).createReader()
    );
    return (await Promise.all(children.map(filesFromEntry))).flat();
  }
  return [];
}

async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items).filter(
    (item) => item.kind === "file"
  );
  if (items.length === 0) return Array.from(dataTransfer.files);

  const nestedFiles = await Promise.all(
    items.map(async (item) => {
      const entry = item.webkitGetAsEntry();
      if (entry) return filesFromEntry(entry);
      const file = item.getAsFile();
      return file ? [file] : [];
    })
  );
  return nestedFiles.flat();
}

async function uploadWithConcurrency(
  files: File[],
  upload: (file: File) => Promise<Id<"documents"> | undefined>
) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(4, files.length) },
    async () => {
      while (nextIndex < files.length) {
        const file = files[nextIndex++];
        await upload(file);
      }
    }
  );
  await Promise.all(workers);
}

/**
 * Resolves the current project's identity from routes that sit beneath a
 * project. The project home is intentionally excluded because it already has
 * a visible DropZone.
 */
export function GlobalDropOverlay() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const documentId = routeSegment(location.pathname, "/documents/");
  const entitySlug = routeSegment(location.pathname, "/entity/");
  const searchId =
    location.pathname === "/search" ? params.get("id") : null;
  const projectParam = params.get("project") as Id<"projects"> | null;

  const document = useQuery(
    api.documents.get,
    documentId ? { id: documentId as Id<"documents"> } : "skip"
  );
  const search = useQuery(
    api.search.get,
    searchId ? { id: searchId as Id<"searches"> } : "skip"
  );
  const entity = useQuery(
    api.entities.getBySlug,
    entitySlug && !projectParam ? { slug: entitySlug } : "skip"
  );

  const isProjectHome = /^\/p\/[^/]+\/?$/.test(location.pathname);
  const projectId = isProjectHome
    ? null
    : (projectParam ??
      document?.projectId ??
      search?.projectId ??
      entity?.projectId ??
      null);

  return projectId ? (
    <ProjectDropOverlay key={projectId} projectId={projectId} />
  ) : null;
}

function ProjectDropOverlay({
  projectId,
}: {
  projectId: Id<"projects">;
}) {
  const { upload, uploads } = useUpload(projectId);
  const [isDragging, setIsDragging] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  useEffect(() => {
    let dragDepth = 0;

    const resetDrag = () => {
      dragDepth = 0;
      setIsDragging(false);
    };
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDropError(null);
      setIsDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setIsDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const dataTransfer = event.dataTransfer;
      resetDrag();
      if (!dataTransfer) return;
      setIsPreparing(true);
      void filesFromDrop(dataTransfer)
        .then((files) => {
          if (files.length === 0) {
            throw new Error("No readable files were found.");
          }
          return uploadWithConcurrency(files, upload);
        })
        .catch(() =>
          setDropError(
            "This folder couldn’t be read. Try dropping its files instead."
          )
        )
        .finally(() => setIsPreparing(false));
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("blur", resetDrag);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("blur", resetDrag);
    };
  }, [upload]);

  return (
    <>
      {(isDragging || isPreparing || uploads.length > 0 || dropError) && (
        <div
          className={`fixed bottom-4 left-4 z-50 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-1.5 rounded-xl bg-background/95 shadow-xl backdrop-blur ${
            isDragging
              ? "pointer-events-none border-2 border-dashed border-primary p-5"
              : "pointer-events-auto border p-2"
          }`}
          role="status"
          aria-live="polite"
        >
          {(isDragging || isPreparing) && (
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                <UploadCloud className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block font-semibold">
                  {isPreparing
                    ? "Preparing upload…"
                    : "Drop files or folders to upload"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  PDFs, CSVs, images, audio, and video
                </span>
              </span>
            </div>
          )}
          {dropError && !isDragging && !isPreparing && (
            <div className="flex items-start gap-2 px-1 py-1 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="flex-1">{dropError}</span>
              <button
                type="button"
                className="rounded p-0.5 hover:bg-accent"
                onClick={() => setDropError(null)}
                aria-label="Dismiss upload error"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {uploads.map((item) => (
            <UploadRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </>
  );
}

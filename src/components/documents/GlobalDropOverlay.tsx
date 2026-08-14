import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { AlertCircle, UploadCloud, X } from "lucide-react";
import { useMatch, useSearchParams } from "react-router";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useUploads, useProjectUploads } from "@/hooks/uploadContext";
import { uploadWithConcurrency } from "@/lib/uploadQueue";
import { UploadRow } from "@/components/documents/UploadRow";
import { isSupportedUpload } from "@/lib/uploadTypes";

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

/**
 * Resolves the current project's identity from any route that sits within a
 * project, including the project home — there is no longer a dropzone parked
 * at the top of the page, so this overlay is the only drop surface there too.
 */
export function GlobalDropOverlay() {
  const [searchParams] = useSearchParams();
  const documentId = useMatch("/documents/:id")?.params.id as
    | Id<"documents">
    | undefined;
  const entitySlug = useMatch("/entity/:slug")?.params.slug;
  const projectSlug = useMatch("/p/:slug")?.params.slug;
  const searchId = useMatch("/search")
    ? (searchParams.get("id") as Id<"searches"> | null)
    : null;
  const projectParam = searchParams.get("project") as Id<"projects"> | null;

  const document = useQuery(
    api.documents.get,
    documentId ? { id: documentId } : "skip"
  );
  const search = useQuery(
    api.search.get,
    searchId ? { id: searchId } : "skip"
  );
  const entity = useQuery(
    api.entities.getBySlug,
    entitySlug && !projectParam ? { slug: entitySlug } : "skip"
  );
  // /p/:slug names the project but doesn't carry its id, and uploads are keyed
  // by id — so on the project home the overlay resolves the row itself.
  const project = useQuery(
    api.projects.getBySlug,
    projectSlug ? { slug: projectSlug } : "skip"
  );

  const projectId =
    project?._id ??
    projectParam ??
    document?.projectId ??
    search?.projectId ??
    entity?.projectId ??
    null;

  return projectId ? (
    <ProjectDropOverlay key={projectId} projectId={projectId} />
  ) : null;
}

function ProjectDropOverlay({
  projectId,
}: {
  projectId: Id<"projects">;
}) {
  const { upload } = useUploads();
  const uploads = useProjectUploads(projectId);
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
          return uploadWithConcurrency(files, (file) =>
            upload(file, projectId)
          );
        })
        .catch(() =>
          setDropError(
            "This folder couldn’t be read. Try dropping its files instead."
          )
        )
        .finally(() => setIsPreparing(false));
    };
    // Ctrl/Cmd+V with files on the clipboard is a drop by another name — a
    // screenshot, or files copied in Finder/Explorer. Clipboard payloads that
    // carry no acceptable file (plain text, a copied cell range) fall through
    // untouched, so ordinary pasting into inputs still works.
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(
        isSupportedUpload
      );
      if (files.length === 0) return;
      event.preventDefault();
      setDropError(null);
      setIsPreparing(true);
      void uploadWithConcurrency(files, (file) => upload(file, projectId))
        .catch(() => setDropError("Those files couldn’t be read."))
        .finally(() => setIsPreparing(false));
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    window.addEventListener("blur", resetDrag);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("blur", resetDrag);
    };
  }, [upload, projectId]);

  return (
    <>
      {(isDragging || isPreparing || uploads.length > 0 || dropError) && (
        <div
          className={`fixed z-50 flex flex-col gap-1.5 rounded-xl bg-background/95 shadow-xl backdrop-blur ${
            // While a drag is over the window the panel becomes the target
            // itself — the bottom-left quarter of the page. It grows out of
            // the same corner the progress card occupies, so the card does not
            // jump on drop.
            isDragging
              ? "pointer-events-none bottom-4 left-4 h-[25vh] min-h-[11rem] w-[max(25vw,20rem)] max-w-[calc(100vw-2rem)] items-center justify-center border-2 border-dashed border-primary p-6"
              : "pointer-events-auto bottom-4 left-4 w-[min(26rem,calc(100vw-2rem))] border p-2"
          }`}
          role="status"
          aria-live="polite"
        >
          {isDragging ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                <UploadCloud className="size-7" />
              </span>
              <span>
                <span className="block text-lg font-semibold text-balance">
                  Drop files or folders to upload
                </span>
                <span className="block text-sm text-muted-foreground">
                  PDFs, CSVs, images, audio, and video
                </span>
              </span>
            </div>
          ) : (
            isPreparing && (
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                  <UploadCloud className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">
                    Preparing upload…
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    PDFs, CSVs, images, audio, and video
                  </span>
                </span>
              </div>
            )
          )}
          {dropError && !isDragging && !isPreparing && (
            <div className="flex items-start gap-2 px-1 py-1 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span className="flex-1">{dropError}</span>
              <button
                type="button"
                className="rounded p-0.5 hover:bg-accent"
                onClick={() => setDropError(null)}
                aria-label="Dismiss upload error"
              >
                <X className="size-4" />
              </button>
            </div>
          )}
          {/* The drag state is a target, not a status panel: in-flight rows
              step aside for it and come back when the drag ends. */}
          {!isDragging &&
            uploads.map((item) => <UploadRow key={item.id} item={item} />)}
        </div>
      )}
    </>
  );
}

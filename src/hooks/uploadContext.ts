import { createContext, useContext, useMemo } from "react";
import type { Id } from "../../convex/_generated/dataModel";

export interface UploadItem {
  id: string;
  projectId: Id<"projects">;
  name: string;
  size: number;
  /** 0-100 upload progress (bytes sent to storage) */
  progress: number;
  status:
    | "preflighting"
    | "converting"
    | "uploading"
    | "finalizing"
    /** The document row exists; the pipeline is still working on it. */
    | "ingesting"
    | "done"
    | "error";
  /** The document's own `status` while this item is "ingesting". */
  stage?: string;
  error?: string;
  detail?: string;
  /**
   * Problems that do not stop the upload but will degrade the result — a
   * scanned page with no text layer, a document past the provider's page limit.
   * Shown so a later empty scan is interpretable instead of mysterious.
   */
  warnings?: string[];
  documentId?: Id<"documents">;
}

export interface UploadContextValue {
  /** Every in-flight item, across projects. */
  uploads: UploadItem[];
  upload: (
    file: File,
    projectId: Id<"projects">
  ) => Promise<Id<"documents"> | undefined>;
  /**
   * Documents the overlay is still holding. The library filters these out so a
   * file appears in exactly one place at a time — the upload card until ingest
   * finishes, the library afterwards.
   */
  heldDocumentIds: Set<Id<"documents">>;
}

export const UploadContext = createContext<UploadContextValue | null>(null);

export function useUploads(): UploadContextValue {
  const value = useContext(UploadContext);
  if (!value) {
    throw new Error("useUploads must be used inside an UploadProvider");
  }
  return value;
}

/** The subset of `uploads` belonging to one project. */
export function useProjectUploads(projectId: Id<"projects">): UploadItem[] {
  const { uploads } = useUploads();
  return useMemo(
    () => uploads.filter((item) => item.projectId === projectId),
    [uploads, projectId]
  );
}

import { createContext, useContext, useMemo } from "react";
import type { Id } from "../../convex/_generated/dataModel";

export interface UploadItem {
  id: string;
  /**
   * What the card is watching. "upload" carries a file from the browser into
   * the pipeline; "analyze" watches a document already in the library go back
   * through the Analyze pass. They share this list because the overlay is the
   * one place the app shows work in flight — the difference is only which
   * status ends the card, and whether the library hides the row meanwhile.
   */
  kind: "upload" | "analyze";
  projectId: Id<"projects">;
  name: string;
  /** Bytes to transfer. Always 0 for "analyze" — nothing is being sent. */
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
    /**
     * The project already has this file, byte for byte. Not an error — the
     * document it duplicates is linked, and nothing was ingested twice.
     */
    | "duplicate"
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
   * Watch documents already in the library re-run the Analyze pass. Adding a
   * card is all this does — the caller enqueues the work itself.
   */
  trackAnalyze: (
    projectId: Id<"projects">,
    documents: { id: Id<"documents">; name: string }[]
  ) => void;
  /**
   * Documents the overlay is still holding. The library filters these out so a
   * file appears in exactly one place at a time — the upload card until ingest
   * finishes, the library afterwards.
   *
   * Re-analyzed documents are deliberately absent: they are already in the
   * library, and hiding a row the user is watching change would be the opposite
   * of what the card is for.
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

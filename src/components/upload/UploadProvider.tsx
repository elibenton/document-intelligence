import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { UploadContext, type UploadItem } from "@/hooks/uploadContext";
import { isSupportedUpload, UNSUPPORTED_REASON } from "@/lib/uploadTypes";
import { isAudioUpload, preflightAudio } from "@/lib/audioPreflight";
import { isPdfUpload, preflightPdf } from "@/lib/pdfPreflight";
import { sha256Hex } from "@/lib/contentHash";
import { fileKindOf, reportIssue } from "@/lib/reportIssue";

let nextUploadId = 0;

/** How long a finished card lingers before the document joins the library. */
const DONE_LINGER_MS = 2500;
const ERROR_LINGER_MS = 8000;
const DUPLICATE_LINGER_MS = 6000;

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
  const convex = useConvex();
  const generateUploadUrl = useMutation(api.upload.generateUploadUrl);
  const createDocument = useMutation(api.upload.createDocument);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const timersRef = useRef<number[]>([]);
  /** Documents whose retirement timer is already queued. */
  const finalizedRef = useRef(new Set<string>());

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

  /**
   * Fail one upload card: show it, retire it, and count it.
   *
   * The four rejection paths below were four copies of patch-then-arm-a-timer,
   * differing only in the linger duration — which is exactly the shape that
   * grows a fifth copy the day someone adds a rejection and forgets the timer.
   * Collapsing them is worth doing on its own; that it leaves a single place
   * for `reportIssue` is the reason a client failure is now visible at all
   * (convex/issues.ts). None of these can carry a documentId: every one of them
   * happens before a document row exists.
   */
  const failUpload = useCallback(
    (
      id: string,
      file: File,
      stage: string,
      error: string,
      options?: { errorCode?: string; lingerMs?: number; pageCount?: number }
    ) => {
      patchUpload(id, { status: "error", error });
      timersRef.current.push(
        window.setTimeout(
          () => removeUpload(id),
          options?.lingerMs ?? ERROR_LINGER_MS
        )
      );
      reportIssue({
        surface: "client",
        stage,
        message: error,
        errorCode: options?.errorCode,
        fileKind: fileKindOf(file),
        sizeBytes: file.size,
        pageCount: options?.pageCount,
        mimeType: file.type || undefined,
      });
    },
    [patchUpload, removeUpload]
  );

  const upload = useCallback(
    async (file: File, projectId: Id<"projects">) => {
      const id = `upload-${nextUploadId++}`;
      setUploads((prev) => [
        ...prev,
        {
          id,
          kind: "upload",
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
        failUpload(id, file, "preflight", UNSUPPORTED_REASON, {
          errorCode: "unsupported_type",
        });
        return undefined;
      }

      try {
        // Identity check before anything expensive: hashing reads the file the
        // browser already has, so a re-drop of a file the project holds costs
        // one indexed query instead of a transfer, a render and four billable
        // Interfaze calls. Audio conversion happens after this deliberately —
        // the hash names the file the user chose, not the encoder's output.
        const contentHash = await sha256Hex(file).catch(() => undefined);
        const existing = contentHash
          ? await convex.query(api.upload.findDuplicate, {
              projectId,
              contentHash,
              name: file.name,
            })
          : { exact: null, sameName: null };
        if (existing.exact) {
          patchUpload(id, {
            status: "duplicate",
            documentId: existing.exact._id,
            detail: `Identical to "${existing.exact.name}", already in this project.`,
          });
          timersRef.current.push(
            window.setTimeout(() => removeUpload(id), DUPLICATE_LINGER_MS)
          );
          return undefined;
        }

        let uploadFile = file;
        const nameWarning = existing.sameName
          ? [`Another file here is also named "${existing.sameName.name}". Its contents differ, so this was uploaded as a separate document.`]
          : [];
        if (isPdfUpload(file)) {
          patchUpload(id, { detail: "Inspecting PDF structure…" });
          const preflight = await preflightPdf(file);
          if (!preflight.ok) {
            // preflight.code is the six-value vocabulary in pdfPreflight.ts —
            // password_protected, invalid_pdf, provider_size_limit and friends.
            // It was classified and then discarded here; the ledger is the first
            // thing to keep it.
            failUpload(id, file, "preflight", preflight.message, {
              errorCode: preflight.code,
              lingerMs: 12_000,
              pageCount: preflight.pageCount ?? undefined,
            });
            return undefined;
          }
          patchUpload(id, {
            detail: preflight.message,
            warnings: [
              ...nameWarning,
              ...preflight.warnings.map((warning) => warning.message),
            ],
          });
        } else if (isAudioUpload(file)) {
          const preflight = await preflightAudio(file);
          if (!preflight.ok) {
            failUpload(id, file, "preflight", preflight.message, {
              errorCode: preflight.code,
              lingerMs: 12_000,
            });
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

        if (nameWarning.length && !isPdfUpload(file)) {
          patchUpload(id, { warnings: nameWarning });
        }
        patchUpload(id, { status: "uploading", progress: 0 });
        const url = await generateUploadUrl();
        const { storageId } = await uploadWithProgress(
          url,
          uploadFile,
          (percent) => patchUpload(id, { progress: percent })
        );
        patchUpload(id, { progress: 100, status: "finalizing" });
        const { documentId, duplicateOf } = await createDocument({
          projectId,
          name: uploadFile.name,
          storageId,
          mimeType: uploadFile.type,
          contentHash,
        });
        // Lost a race with a concurrent upload of the same bytes; the server
        // kept the first row and discarded these.
        if (duplicateOf) {
          patchUpload(id, {
            status: "duplicate",
            documentId,
            detail: `Identical to "${duplicateOf}", already in this project.`,
          });
          timersRef.current.push(
            window.setTimeout(() => removeUpload(id), DUPLICATE_LINGER_MS)
          );
          return undefined;
        }
        // Not "done": the bytes have landed but the pipeline hasn't run. The
        // card holds the file until `ingestStates` reports a terminal status.
        patchUpload(id, {
          status: "ingesting",
          stage: "uploaded",
          documentId,
        });
        return documentId;
      } catch (e) {
        // Everything from the hash to `createDocument`: the storage PUT's
        // network errors and HTTP statuses, the audio converter, and the
        // finalize mutation. Reported under one stage because from here the
        // message is the only thing that distinguishes them, and the
        // fingerprint groups on the message.
        failUpload(
          id,
          file,
          "upload",
          e instanceof Error ? e.message : String(e),
          { errorCode: e instanceof Error ? e.name : undefined }
        );
        return undefined;
      }
    },
    [
      convex,
      generateUploadUrl,
      createDocument,
      patchUpload,
      removeUpload,
      failUpload,
    ]
  );

  /**
   * Put a card up for each document about to be re-analyzed.
   *
   * Cards go up before the work is enqueued, so the overlay answers "did that
   * do anything?" immediately rather than after a round trip per document. A
   * document already on screen is skipped: pressing Re-analyze twice should not
   * stack two cards for one pass.
   */
  const trackAnalyze = useCallback(
    (
      projectId: Id<"projects">,
      documents: { id: Id<"documents">; name: string }[]
    ) => {
      setUploads((prev) => {
        const watched = new Set(
          prev
            .filter((u) => u.kind === "analyze" && u.documentId)
            .map((u) => u.documentId)
        );
        const added = documents
          .filter((doc) => !watched.has(doc.id))
          .map<UploadItem>((doc) => ({
            id: `analyze-${nextUploadId++}`,
            kind: "analyze",
            projectId,
            name: doc.name,
            size: 0,
            progress: 0,
            status: "ingesting",
            stage: "analyze",
            documentId: doc.id,
          }));
        if (added.length === 0) return prev;
        // A card for this document may have been retired earlier in the
        // session; clear the guard so this pass gets its own linger timer.
        for (const item of added) {
          if (item.documentId) finalizedRef.current.delete(item.documentId);
        }
        return [...prev, ...added];
      });
    },
    []
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

  useEffect(() => {
    if (!states) return;

    const byId = new Map(states.map((state) => [state._id, state]));

    /**
     * What ends the card, per kind.
     *
     * An upload watches the document's own status. A re-analysis watches the
     * analyze job instead, because the document sits at "parsed"/"completed"
     * throughout — reading `status` there would call the pass finished the
     * instant it started. A missing document ends either kind: it was deleted
     * while the card was up.
     */
    const outcomeOf = (
      item: UploadItem,
      state: NonNullable<typeof states>[number]
    ): { settled: "done" | "error" | null; stage: string } => {
      if (state.status === "missing") return { settled: "done", stage: "" };
      if (item.kind === "analyze") {
        if (state.analyzeStatus === "completed") {
          return { settled: "done", stage: "" };
        }
        if (state.analyzeStatus === "failed") {
          return { settled: "error", stage: "" };
        }
        // "pending" and a job row not yet written both read as queued.
        return { settled: null, stage: "analyze" };
      }
      if (state.status === "completed") return { settled: "done", stage: "" };
      if (state.status === "failed") return { settled: "error", stage: "" };
      return { settled: null, stage: state.status };
    };

    setUploads((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (item.status !== "ingesting" || !item.documentId) return item;
        const state = byId.get(item.documentId);
        if (!state) return item;
        const { settled, stage } = outcomeOf(item, state);
        if (settled === "done") {
          changed = true;
          return { ...item, status: "done" as const, stage: undefined };
        }
        if (settled === "error") {
          changed = true;
          return {
            ...item,
            status: "error" as const,
            error: state.errorMessage ?? "Processing failed.",
          };
        }
        if (stage === item.stage) return item;
        changed = true;
        return { ...item, stage };
      });
      return changed ? next : prev;
    });

    // Retire the card a beat after it settles, so it is seen finishing rather
    // than vanishing. Guarded by a ref: a re-run before the state patch lands
    // would otherwise queue the timer twice.
    for (const item of uploads) {
      if (item.status !== "ingesting" || !item.documentId) continue;
      const state = byId.get(item.documentId);
      if (!state) continue;
      const { settled } = outcomeOf(item, state);
      if (!settled || finalizedRef.current.has(item.documentId)) continue;
      finalizedRef.current.add(item.documentId);
      const documentId = item.documentId;
      timersRef.current.push(
        window.setTimeout(
          () => setUploads((prev) => prev.filter((u) => u.documentId !== documentId)),
          settled === "error" ? ERROR_LINGER_MS : DONE_LINGER_MS
        )
      );
    }
  }, [states, uploads]);

  const heldDocumentIds = useMemo(() => {
    const held = new Set<Id<"documents">>();
    for (const item of uploads) {
      // A duplicate points at a document that is already in the library and
      // must stay visible — holding it would blank the row it duplicates. A
      // re-analysis is the same case: the document never left the library.
      if (
        item.documentId &&
        item.status !== "duplicate" &&
        item.kind !== "analyze"
      ) {
        held.add(item.documentId);
      }
    }
    return held;
  }, [uploads]);

  const value = useMemo(
    () => ({ uploads, upload, trackAnalyze, heldDocumentIds }),
    [uploads, upload, trackAnalyze, heldDocumentIds]
  );

  return (
    <UploadContext.Provider value={value}>{children}</UploadContext.Provider>
  );
}

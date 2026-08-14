import type { ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";

/**
 * The browser's end of the failure ledger (convex/issues.ts).
 *
 * This exists because the most useful failures in the app never reach the
 * server on their own. A file rejected by preflight, a conversion that threw, a
 * storage PUT that timed out, a crashed render — every one of them is handled
 * entirely in this tab and then forgotten, which means the failures that stop
 * someone from *becoming* a user are precisely the ones nothing has ever
 * counted.
 *
 * Reporting is best-effort in the strongest sense: it is wrapped in a
 * `try`/`catch` that ignores everything, including the signed-out case, because
 * the alternative is an error report that replaces the error the user came here
 * with. Nothing downstream may depend on it having happened.
 */

/**
 * The build the *browser* is running, which is not always the build the backend
 * is: a user with a tab open across a deploy reports crashes from the old
 * bundle. Substituted at build time by the `define` in vite.config.ts, so it is
 * a literal here rather than a lookup — hence the ambient declaration and the
 * `typeof` guard, which covers any entry point Vite does not process.
 */
declare const __BUILD_SHA__: string | undefined;

export const BUILD_SHA: string | undefined =
  typeof __BUILD_SHA__ === "string" && __BUILD_SHA__ ? __BUILD_SHA__ : undefined;

/**
 * Registered by src/root.tsx at module scope, rather than imported from there,
 * to avoid a cycle — and so the `window` handlers in entry.client.tsx, which sit
 * outside React entirely, can reach the same client the app uses.
 */
let client: ConvexReactClient | null = null;

export function registerIssueReporter(c: ConvexReactClient): void {
  client = c;
}

export interface ClientIssue {
  /** "client" for an upload that failed, "crash" for a throw. */
  surface: "client" | "crash";
  /** "preflight" | "convert" | "upload" | "finalize" | "boundary" | "unhandled" */
  stage: string;
  message: string;
  /** A closed-vocabulary code where one exists — a PdfPreflightResult code, an error name. */
  errorCode?: string;
  fileKind?: string;
  sizeBytes?: number;
  pageCount?: number;
  mimeType?: string;
}

/**
 * Crash reports allowed per page load.
 *
 * The failure mode every crash reporter eventually meets: a component that
 * throws on every render, or a retry loop whose rejections nobody handles,
 * turns one defect into an unbounded stream of writes. The ledger would survive
 * it — they all share a fingerprint, so it is one row with an absurd count —
 * but the user's tab and the deployment would both spend the whole time on it.
 *
 * A per-load cap rather than a global one: a reload is a new decision by a
 * human, and the count on the row still says the failure recurred. Upload
 * failures are deliberately not capped — a folder drop of two hundred bad files
 * is two hundred real, distinct rejections a person should be told about.
 */
const MAX_CRASH_REPORTS = 10;
let crashReports = 0;

export function reportIssue(issue: ClientIssue): void {
  if (issue.surface === "crash" && ++crashReports > MAX_CRASH_REPORTS) return;
  // Deliberately not awaited by callers: a failure card must render at the
  // speed of the failure, not at the speed of the network.
  void (async () => {
    try {
      await client?.mutation(api.issues.report, { ...issue, buildSha: BUILD_SHA });
    } catch {
      // Signed out, offline, or the endpoint is unhappy. See the file header:
      // there is nothing useful to do with a failure to report a failure.
    }
  })();
}

/**
 * The coarse kind a file is, matching the vocabulary `documents.mediaType`
 * uses, so a client-side rejection and a pipeline failure for the same sort of
 * file are recognisably about the same sort of file.
 */
export function fileKindOf(file: File): string {
  const type = file.type.toLowerCase();
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  if (type === "text/csv" || ext === "csv") return "csv";
  if (ext === "docx" || ext === "doc") return "docx";
  return ext || "unknown";
}

import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Interfaze requests are long-lived and bursty, so the pool exists to bound
 * them — but 3 was bounding the wrong thing. Measured over 782 apiLogs rows
 * there has never been a single `rate_limited` error, while a bulk upload
 * routinely left a two-second Scan (`ocr` p50 2.0s) queued behind other
 * documents' full pipelines. The ceiling that mattered was slot turnover, not
 * provider concurrency.
 *
 * Enrichment runs on its own pool (convex/enrichmentPool.ts), so this number
 * now covers only work a human is watching a progress UI for.
 */
export const PROCESSING_MAX_PARALLELISM = 10;

export const processingPool = new Workpool(components.processingWorkpool, {
  retryActionsByDefault: false,
});

/**
 * `maxParallelism` is threaded through every enqueue rather than set on the
 * constructor. That looks redundant with processingControl's config.update, but
 * workpool config is global and last-write-wins per enqueue: an enqueue
 * carrying a constructor default would silently resume a paused queue.
 *
 * `onComplete` is what makes the terminal state reliable. It runs whether the
 * work succeeded, failed, or was canceled — including when Convex kills the
 * action at its 10-minute limit, which is precisely the case an action's own
 * catch block cannot cover.
 */
export function processingEnqueueOptions(
  paused: boolean,
  job?: { documentId: Id<"documents">; stage: string }
) {
  return {
    retry: false as const,
    maxParallelism: paused ? 0 : PROCESSING_MAX_PARALLELISM,
    ...(job
      ? { onComplete: internal.processing.jobComplete, context: job }
      : {}),
  };
}

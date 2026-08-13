import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Interfaze requests are long-lived and bursty. A small shared pool keeps bulk
 * uploads from consuming every action slot while still allowing independent
 * documents to make progress together.
 */
export const PROCESSING_MAX_PARALLELISM = 3;

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

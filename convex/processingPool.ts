import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * One pool runs every Interfaze stage, enrichment included, and this number is
 * sized to the deployment, not the provider: S16 executes at most 8 scheduled
 * functions at once, and the workpool runs both its jobs and its own main loop
 * through the scheduler. 4 here plus the render pool's 3 leaves the deployment
 * one slot of headroom for pool bookkeeping, stage-chaining `ctx.scheduler`
 * calls, and crons — a configured parallelism the scheduler cannot actually
 * deliver just moves the queue somewhere invisible.
 */
export const PROCESSING_MAX_PARALLELISM = 4;

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

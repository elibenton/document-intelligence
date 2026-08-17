import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api";
import { RENDERER_VERSION } from "./rendererConfig";
import type { Id } from "./_generated/dataModel";

/**
 * Page geometry extraction runs in a Node action, and Node actions get killed by the
 * platform for reasons the action itself never observes: container eviction,
 * the 10-minute limit, transient capacity errors. Those kills happen *before*
 * renderBatch's catch block, so nothing records a failure and nothing schedules
 * a successor — the document is stranded on renderStatus "rendering" forever.
 *
 * A raw ctx.scheduler.runAfter cannot fix that; the workpool can, because it
 * retries a failed action. Retrying is safe here in a way it is not for
 * Interfaze: commits are versioned per page, so a retry skips every page that
 * already exists and only redoes the work the dead action never finished. No
 * billable call is duplicated and no finished page is redone.
 */
export const RENDER_MAX_PARALLELISM = 3;

export const renderPool = new Workpool(components.renderWorkpool, {
  maxParallelism: RENDER_MAX_PARALLELISM,
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    maxAttempts: 4,
    initialBackoffMs: 2000,
    base: 2,
  },
});

/**
 * The terminal render state is decided in exactly one place: the pool's
 * onComplete, which runs whether the work succeeded, failed, or was canceled,
 * and only after retries are exhausted. renderBatch's own catch must not write
 * "failed" — an intermediate attempt's throw is not a verdict, and writing one
 * would disarm the watchdog and burn a renderAttempt on every retry.
 */
export function renderEnqueueOptions(documentId: Id<"documents">) {
  return {
    onComplete: internal.render.renderJobComplete,
    context: { documentId, rendererVersion: RENDERER_VERSION },
  };
}

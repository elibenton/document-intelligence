import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Background enrichment, separated from the work a human is waiting on.
 *
 * Relationship mapping is the longest stage in the pipeline (`relationships`
 * p50 37.8s against `ocr` p50 2.0s) and nobody is watching it: it is
 * explicitly an enrichment pass that must not fail its document. Sharing the
 * processing pool meant a file someone had just dropped could sit behind
 * relationship mapping for a document nobody had open — measured queue wait
 * p90 of 67s.
 *
 * Raising PROCESSING_MAX_PARALLELISM shrinks that window but cannot close it,
 * because both kinds of work still draw from one set of slots. A second pool
 * makes it structural: interactive work is never behind enrichment at any
 * parallelism.
 *
 * Kept at 3 deliberately. Nothing here is latency-sensitive, and this is the
 * knob that bounds total concurrent Interfaze requests alongside the
 * interactive pool.
 */
export const ENRICHMENT_MAX_PARALLELISM = 3;

/** Stages that run on this pool rather than the processing pool. */
export const ENRICHMENT_STAGES: ReadonlySet<string> = new Set(["relationships"]);

export const enrichmentPool = new Workpool(components.enrichmentWorkpool, {
  retryActionsByDefault: false,
});

/**
 * Mirrors processingEnqueueOptions, including threading `maxParallelism`
 * through every enqueue: workpool config is global and last-write-wins, so an
 * enqueue carrying a constructor default would silently resume a paused queue.
 *
 * `onComplete` is the same handler the processing pool uses — the terminal
 * state of a job row does not depend on which pool ran it.
 */
export function enrichmentEnqueueOptions(
  paused: boolean,
  job: { documentId: Id<"documents">; stage: string }
) {
  return {
    retry: false as const,
    maxParallelism: paused ? 0 : ENRICHMENT_MAX_PARALLELISM,
    onComplete: internal.processing.jobComplete,
    context: job,
  };
}

import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";

/**
 * Interfaze requests are long-lived and bursty. A small shared pool keeps bulk
 * uploads from consuming every action slot while still allowing independent
 * documents to make progress together.
 */
export const PROCESSING_MAX_PARALLELISM = 3;

export const processingPool = new Workpool(components.processingWorkpool, {
  retryActionsByDefault: false,
});

export function processingEnqueueOptions(paused: boolean) {
  return {
    retry: false as const,
    maxParallelism: paused ? 0 : PROCESSING_MAX_PARALLELISM,
  };
}

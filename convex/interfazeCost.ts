/**
 * Interfaze usage + cost accounting.
 *
 * Deliberately free of the `interfaze` SDK and of "use node": convex/apiLogs.ts
 * and convex/embeddings.ts need these types, and importing them from the
 * node-only client module only worked because type imports are erased at
 * compile time. Anything that reaches for a *value* here would have broken.
 */

// ---------------------------------------------------------------------------
// Usage logging — every call reports its token usage + estimated cost to an
// optional logger (see convex/apiLogs.ts), which persists the mini API log
// shown on the settings page.
// ---------------------------------------------------------------------------

export interface ApiUsage {
  provider: string;
  operation: string;
  model: string;
  status: "ok" | "error";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  cacheHit?: boolean;
  error?: string;
}

export type UsageLogger = (usage: ApiUsage) => Promise<void>;

// Interfaze pricing (https://interfaze.ai/pricing).
const INTERFAZE_USD_PER_M_INPUT = 1.5;
const INTERFAZE_USD_PER_M_OUTPUT = 3.5;

/**
 * A cache hit is free: "cached outputs are not charged again, and there is no
 * separate cache bill" (https://interfaze.ai/docs/caching).
 *
 * This used to assume the provider also zeroed the *token counts* on a hit, so
 * costing them at list price was harmless. It does not — a served-from-cache
 * completion reports its full prompt/completion tokens like any other. Costing
 * those overstated the ledger by 20% ($6.31 of the first $31.93, across 129
 * hits), which is exactly the number every cost decision is read off.
 *
 * Tokens are still logged on a hit: they measure how much work the pipeline
 * asked for, which is what capacity and prompt-size questions need. Only the
 * dollars are zeroed, because only the dollars were never charged.
 */
export function interfazeCostUsd(
  promptTokens: number,
  completionTokens: number,
  cacheHit?: boolean
): number {
  if (cacheHit) return 0;
  return (
    (promptTokens * INTERFAZE_USD_PER_M_INPUT +
      completionTokens * INTERFAZE_USD_PER_M_OUTPUT) /
    1e6
  );
}

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

// Interfaze pricing (https://interfaze.ai/pricing). Cached tokens are free and
// excluded from the reported token counts, so no cache adjustment is needed.
const INTERFAZE_USD_PER_M_INPUT = 1.5;
const INTERFAZE_USD_PER_M_OUTPUT = 3.5;

export function interfazeCostUsd(
  promptTokens: number,
  completionTokens: number
): number {
  return (
    (promptTokens * INTERFAZE_USD_PER_M_INPUT +
      completionTokens * INTERFAZE_USD_PER_M_OUTPUT) /
    1e6
  );
}

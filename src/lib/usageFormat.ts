/**
 * Display vocabulary for API usage: operation names and number formats.
 *
 * One copy, read by the settings page's API log and the document page's usage
 * breakdown, so the same call can never be labeled two ways.
 */

export const operationLabels: Record<string, string> = {
  parse: "Parse",
  ocr: "OCR",
  analyze: "Analyze",
  rename: "Rename",
  translate: "Translate",
  extract: "Extract",
  transcribe: "Transcribe",
  visual: "Visual scan",
  metadata: "Metadata",
  relationships: "Relationships",
  research: "Research",
  search_plan: "Search · plan",
  search_answer: "Search · answer",
  embeddings: "Embeddings",
};

export function operationLabel(operation: string): string {
  return operationLabels[operation] ?? operation;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatApiDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

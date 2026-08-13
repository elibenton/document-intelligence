import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Age out per-call API log detail once a day.
 *
 * The log is a measurement stream, not the ledger: lifetime calls, tokens and
 * cost live in the sharded `apiUsageTotals` rows, which are never pruned. Only
 * the per-call detail expires, and 30 days is enough to answer the questions it
 * exists for — which operation truncates, what p95 latency looks like, whether
 * a prompt change moved anything.
 */
crons.daily(
  "prune api logs",
  { hourUTC: 8, minuteUTC: 0 },
  internal.apiLogs.pruneOldLogs,
  {}
);

export default crons;

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

/**
 * Expire anonymous demo sessions and everything they uploaded.
 *
 * Hourly rather than daily: this one is not pruning measurement detail, it is
 * releasing storage leased to the public. A day's worth of unswept demo
 * uploads is a day's worth of files nobody owns.
 */
crons.hourly(
  "sweep demo sessions",
  { minuteUTC: 20 },
  internal.demo.sweepExpired,
  {}
);

/**
 * Fail jobs whose action died without reaching its catch block.
 *
 * Stages run as plain scheduled actions; a platform kill (the action time
 * limit, container eviction) leaves the job row on "running" and the document
 * on "parsing" forever. This sweep is the only place that case is ever heard
 * from — see processing.sweepStuckJobs for the threshold.
 */
crons.interval(
  "sweep stuck jobs",
  { minutes: 10 },
  internal.processing.sweepStuckJobs,
  {}
);

export default crons;

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Tooltip } from "@/components/ui/tooltip";
import {
  formatApiDuration,
  formatCost,
  formatTokens,
  operationLabel,
} from "@/lib/usageFormat";

/**
 * What this document cost to process: one row per pipeline operation with API
 * time, tokens, and estimated dollars, plus a total. Reads the same per-call
 * log the settings page shows, scoped to this document.
 */
export function DocumentUsage({ documentId }: { documentId: Id<"documents"> }) {
  const rows = useQuery(api.apiLogs.byDocument, { documentId });
  if (rows === undefined) return null;

  return (
    <div className="flex flex-col gap-1.5 border-t pt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        API usage
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No API calls on record. Call detail is kept for 30 days, so older
          documents show nothing here.
        </p>
      ) : (
        <UsageTable rows={rows} />
      )}
    </div>
  );
}

type UsageRow = FunctionReturnType<typeof api.apiLogs.byDocument>[number];

function UsageTable({ rows }: { rows: UsageRow[] }) {
  const total = rows.reduce(
    (sum, r) => ({
      calls: sum.calls + r.calls,
      errors: sum.errors + r.errors,
      promptTokens: sum.promptTokens + r.promptTokens,
      completionTokens: sum.completionTokens + r.completionTokens,
      costUsd: sum.costUsd + r.costUsd,
      durationMs: sum.durationMs + r.durationMs,
      cacheHits: sum.cacheHits + r.cacheHits,
    }),
    {
      calls: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      durationMs: 0,
      cacheHits: 0,
    }
  );

  const tokensTitle = (r: { promptTokens: number; completionTokens: number }) =>
    `${r.promptTokens.toLocaleString()} in · ${r.completionTokens.toLocaleString()} out`;

  return (
    <>
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-3 gap-y-1 text-xs">
        <span />
        <span className="text-right text-2xs text-muted-foreground">Time</span>
        <span className="text-right text-2xs text-muted-foreground">Tokens</span>
        <span className="text-right text-2xs text-muted-foreground">Cost</span>

        {rows.map((row) => (
          <div key={row.operation} className="col-span-4 grid grid-cols-subgrid items-baseline">
            <span className="min-w-0 truncate">
              {operationLabel(row.operation)}
              {row.calls > 1 && (
                <span className="ml-1 text-2xs text-muted-foreground">
                  ×{row.calls}
                </span>
              )}
              {row.errors > 0 && (
                <span className="ml-1 text-2xs text-destructive">
                  {row.errors} failed
                </span>
              )}
            </span>
            <span className="text-right tabular-nums text-muted-foreground">
              {formatApiDuration(row.durationMs)}
            </span>
            <Tooltip content={tokensTitle(row)}>
              <span className="text-right tabular-nums">
                {formatTokens(row.promptTokens + row.completionTokens)}
              </span>
            </Tooltip>
            <span className="text-right tabular-nums">
              {formatCost(row.costUsd)}
            </span>
          </div>
        ))}

        <div className="col-span-4 grid grid-cols-subgrid items-baseline border-t pt-1 font-medium">
          <span>
            Total
            <span className="ml-1 text-2xs font-normal text-muted-foreground">
              {total.calls} call{total.calls === 1 ? "" : "s"}
            </span>
          </span>
          <span className="text-right tabular-nums">
            {formatApiDuration(total.durationMs)}
          </span>
          <Tooltip content={tokensTitle(total)}>
            <span className="text-right tabular-nums">
              {formatTokens(total.promptTokens + total.completionTokens)}
            </span>
          </Tooltip>
          <span className="text-right tabular-nums">
            {formatCost(total.costUsd)}
          </span>
        </div>
      </div>
      <p className="text-2xs leading-snug text-muted-foreground">
        Time is API time summed per call — parallel calls overlap, so it can
        exceed elapsed time.
        {total.cacheHits > 0 &&
          ` ${total.cacheHits} call${total.cacheHits === 1 ? "" : "s"} served free from the provider cache.`}
      </p>
    </>
  );
}

import { Link } from "react-router";
import { useQuery } from "convex/react";
import { AlertCircle } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

/**
 * What the pipeline made of the dropped file, updating as each stage lands.
 *
 * One endpoint, `demo.result`. A signed-in document page reads six; this reads
 * one, because the demo shows a fixed handful of facts and every extra demo
 * endpoint is another public surface whose ownership walk has to be right.
 * DemoStages reads the same query with the same args and so shares the one
 * subscription rather than opening a second.
 *
 * The stage-by-stage progress is not here — it runs across the top of the page,
 * in DemoStages, where it takes the headline's place while the pipeline works.
 */

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

export function DemoResults({ sessionToken }: { sessionToken: string }) {
  const result = useQuery(api.demo.result, { sessionToken });

  if (result === undefined) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner />
        Starting…
      </div>
    );
  }
  if (result === null) return null;

  if (result.status === "failed") {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-start gap-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p>{result.errorMessage ?? "This document could not be read."}</p>
        </div>
        <Link to="/signup" className={buttonVariants()}>
          Sign up — it's free
        </Link>
      </div>
    );
  }

  const done = result.status === "completed";

  return (
    <div className="space-y-6 p-6">
      {result.displayName && (
        <div>
          <h3 className="text-lg font-semibold text-balance">
            {result.displayName}
          </h3>
          <p className="text-xs text-muted-foreground">{result.name}</p>
        </div>
      )}

      {(result.kinds.length > 0 || result.primaryCategory) && (
        <div className="flex flex-wrap gap-1.5">
          {result.primaryCategory && <Badge>{result.primaryCategory}</Badge>}
          {result.kinds.map((kind) => (
            <Badge key={kind} variant="secondary">
              {kind}
            </Badge>
          ))}
        </div>
      )}

      {(result.documentDate || result.documentPlace || result.pageCount) && (
        <dl className="grid grid-cols-2 gap-3">
          {result.pageCount !== null && (
            <Fact
              label="Pages"
              value={String(result.pageCount)}
            />
          )}
          {result.documentDate && (
            <Fact label="Dated" value={result.documentDate} />
          )}
          {result.documentPlace && (
            <Fact label="Place" value={result.documentPlace} />
          )}
        </dl>
      )}

      {result.tableOfContents.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs text-muted-foreground">Contents</h4>
          <ol className="space-y-1">
            {result.tableOfContents.map((item, index) => (
              <li
                key={`${item.page}-${index}`}
                className="flex justify-between gap-3 text-sm"
                style={{ paddingLeft: `${(item.level - 1) * 12}px` }}
              >
                <span className="truncate">{item.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {item.page}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {result.entities.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs text-muted-foreground">
            People, places and organizations
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {result.entities.map((entity) => (
              <Badge key={entity._id} variant="outline">
                {entity.name}
                {entity.mentionCount > 1 && (
                  <span className="ml-1 text-muted-foreground">
                    {entity.mentionCount}
                  </span>
                )}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {done && (
        <div className="rounded-md border p-4">
          <p className="mb-3 text-sm text-balance">
            That's one document. An account gets you projects, search across
            everything you've thrown in, and answers cited back to the page.
          </p>
          <Link to="/signup" className={buttonVariants()}>
            Sign up — it's free
          </Link>
        </div>
      )}
    </div>
  );
}

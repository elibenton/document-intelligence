import { useQuery } from "convex/react";
import { Check } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Spinner } from "@/components/ui/spinner";

/**
 * The pipeline's progress, laid out as a horizontal run of steps directly under
 * the headline — where the product's one-line claim sits until a file is
 * dropped, and which it crossfades out to make room for.
 *
 * Horizontal, not the vertical list this used to be inside the results pane:
 * up here it is standing in for a single line of prose, so it has to occupy a
 * line rather than push the panel down by five rows every time a visitor drops
 * something.
 *
 * The subscription is the same `demo.result` DemoResults already holds — same
 * query, same args, so convex/react serves both from one subscription rather
 * than opening a second.
 */

/** The stages a visitor watches, in the order convex/processing.ts runs them. */
const STAGES: { status: string; label: string }[] = [
  { status: "uploaded", label: "Uploaded" },
  { status: "parsing", label: "Reading the pages" },
  { status: "parsed", label: "Working out what it is" },
  { status: "extracting", label: "Pulling out names and dates" },
  { status: "completed", label: "Done" },
];

function stageIndex(status: string): number {
  const found = STAGES.findIndex((s) => s.status === status);
  return found === -1 ? 0 : found;
}

export function DemoStages({ sessionToken }: { sessionToken?: string }) {
  // Undefined while the file is still being checked and uploaded: there is no
  // session to ask about yet, but the first step is already underway, so the
  // run is drawn with step one in progress rather than not drawn at all.
  const result = useQuery(
    api.demo.result,
    sessionToken ? { sessionToken } : "skip"
  );

  const status = result?.status;
  const failed = status === "failed";
  const done = status === "completed";
  const current = status && !failed ? stageIndex(status) : 0;

  return (
    <ol className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
      {STAGES.map((stage, index) => {
        const complete = index < current || done;
        const active = !failed && !complete && index === current;
        return (
          <li
            key={stage.status}
            className={`flex items-center gap-1.5 text-sm transition-opacity duration-500 ${
              complete || active ? "opacity-100" : "opacity-40"
            }`}
          >
            {complete ? (
              <Check className="size-4 shrink-0 text-muted-foreground" />
            ) : active ? (
              <Spinner />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            {stage.label}
          </li>
        );
      })}
    </ol>
  );
}

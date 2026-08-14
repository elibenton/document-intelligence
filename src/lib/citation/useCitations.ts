import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  DEFAULT_CITATION_STYLE,
  type CitationStyle,
} from "../../../convex/projectTemplates";
import { loadFormatter, type Formatter } from "./format";

/**
 * The citation formatter for one answer, in its project's style.
 *
 * Returns null for a `numeric` project, which is every project by default and
 * the app's original behaviour — the `[n]` markers and the numbered source
 * cards. Nothing is imported in that case, so the ~700KB of engine and style
 * sheets stays off the wire.
 *
 * Deliberately keyed off the answer's *own* documents rather than the whole
 * project: an author-date style disambiguates two same-surname authors against
 * each other, so the set being cited is the unit that has to be formatted
 * together.
 */
export function useCitations(
  projectId: Id<"projects"> | null,
  documentIds: Id<"documents">[]
): { formatter: Formatter | null; style: CitationStyle } {
  const project = useQuery(api.projects.get, projectId ? { id: projectId } : "skip");
  const style = (project?.citationStyle ?? DEFAULT_CITATION_STYLE) as CitationStyle;

  const sources = useQuery(
    api.documents.citationSources,
    documentIds.length > 0 && style !== "numeric" ? { ids: documentIds } : "skip"
  );

  // What a formatter would have to be built for. Empty means "nothing to
  // format" — a numeric project, or an answer that cites nothing.
  const key =
    style === "numeric" || !sources || sources.length === 0
      ? ""
      : `${style}:${sources.map((s) => s._id).join(",")}`;

  // Held together with the key it was built for, rather than cleared in the
  // effect when the key changes. Clearing would be a synchronous setState
  // inside an effect — a cascading render, and what the react-hooks lint rule
  // is there to catch. Comparing keys on the way out is the same guarantee
  // without the extra pass: a formatter built for the previous style or the
  // previous set of sources is simply not returned.
  const [built, setBuilt] = useState<{
    key: string;
    formatter: Formatter | null;
  } | null>(null);

  // The engine is loaded and built asynchronously, so the answer renders in
  // numeric form first and re-renders once the style is ready. That ordering is
  // deliberate: a citation style is presentation, and waiting on 700KB before
  // showing an answer the user already asked for would be the wrong trade.
  useEffect(() => {
    if (!key || !sources) return;
    let live = true;
    void loadFormatter(style, sources).then((next) => {
      if (live) setBuilt({ key, formatter: next });
    });
    return () => {
      live = false;
    };
  }, [key, style, sources]);

  return { formatter: built?.key === key ? built.formatter : null, style };
}

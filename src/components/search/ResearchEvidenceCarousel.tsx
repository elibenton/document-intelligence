import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { Link } from "react-router";
import { useQuery } from "convex/react";
import ReactMarkdown from "react-markdown";
import { ArrowUpRight, ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useCitations } from "@/lib/citation/useCitations";
import type { Formatter } from "@/lib/citation/format";
import type { CitationStyle } from "../../../convex/projectTemplates";
import type { Id } from "../../../convex/_generated/dataModel";
import { Tooltip } from "@/components/ui/tooltip";

interface ResearchResult {
  documentId: Id<"documents">;
  documentName: string;
  pageNumber: number;
  snippet: string;
}

interface MatchBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const PAGE_WIDTH = 540;

function normalizeText(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchingBoxes(
  blocks: Array<{
    _id: string;
    text: string;
    bbox?: { x: number; y: number; width: number; height: number };
  }>,
  snippet: string
): MatchBox[] {
  const target = normalizeText(snippet);
  if (!target) return [];
  const targetTokens = new Set(target.split(" "));
  const scored = blocks
    .filter((block) => block.bbox && normalizeText(block.text))
    .map((block) => {
      const text = normalizeText(block.text);
      const tokens = text.split(" ");
      const shared = tokens.filter((token) => targetTokens.has(token)).length;
      const coverage = shared / Math.max(tokens.length, 1);
      const contained =
        text.length >= 8 && (target.includes(text) || text.includes(target));
      return {
        block,
        score: contained ? 2 + Math.min(text.length, target.length) / 500 : coverage,
        shared,
        contained,
      };
    })
    .sort((a, b) => b.score - a.score);

  const containedMatches = scored.filter(({ contained }) => contained);
  let matches =
    containedMatches.length > 0
      ? containedMatches
      : scored.filter(({ score, shared }) => shared >= 3 && score >= 0.72);
  if (matches.length === 0 && scored[0]?.score > 0) {
    matches = [scored[0]];
  }

  return matches.slice(0, 6).map(({ block }) => ({
    id: block._id,
    x: block.bbox!.x,
    y: block.bbox!.y,
    width: block.bbox!.width,
    height: block.bbox!.height,
  }));
}

/**
 * Turn the model's `[n]` markers into links to their evidence card, and — for a
 * project on a real citation style — replace the visible label with that
 * style's own in-text form.
 *
 * The anchor is always `#citation-n`, whatever the label says, because the
 * marker's *position* is what ties a claim to a page. The stored answer keeps
 * its plain `[n]` forever: style is applied here, at render, which is what lets
 * a project switch from numbered to Chicago and have every answer it already
 * has re-format instead of going stale.
 */
function citationMarkdown(
  answer: string,
  formatter: Formatter | null,
  inline: boolean
) {
  return answer.replace(/\[(\d+)](?!\()/g, (_match, digits: string) => {
    const number = Number(digits);
    const label = inline && formatter ? formatter.inText(number - 1) : `[${number}]`;
    // The label can contain brackets of its own; an unescaped "]" would end the
    // markdown link early and spill the rest into the paragraph.
    const safe = label.replace(/([[\]])/g, "\\$1");
    return `[${safe}](#citation-${number})`;
  });
}

/**
 * Whether this style's in-text form belongs *in* the sentence.
 *
 * APA and MLA are parenthetical — "(Berman, 2013)" reads inline, which is what
 * they are for. A Chicago note is a complete sentence ("Sheri Berman, "The
 * Promise of the Arab Spring," Foreign Affairs 92, no. 1 (2013): 64–74.") and
 * belongs in a note, with a number in the text pointing at it — which is
 * exactly what the numbered badge already is. Dropping a whole note into the
 * middle of a paragraph would be the wrong rendering of a correct citation.
 */
function hasInlineCitations(style: CitationStyle): boolean {
  return style === "apa" || style === "mla";
}

function CitationButton({
  number,
  label,
  result,
  active,
  onSelect,
}: {
  number: number;
  /** The style's own in-text form, when it has one. Absent = numbered badge. */
  label?: string;
  result: ResearchResult;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    // Was a CSS-only tooltip: a `role="tooltip"` span revealed by
    // group-hover/group-focus-within, with no collision handling — so a
    // citation near the right edge rendered its card off-screen — and never
    // referenced by aria-describedby, so the role was decorative.
    <span className="relative mx-0.5 inline-flex align-super not-prose">
      <Tooltip
        content={
          <span className="block max-w-64 text-left">
            <span className="block font-medium">{result.documentName}</span>
            <span className="text-muted-foreground">
              Page {result.pageNumber + 1}
            </span>
          </span>
        }
      >
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Citation ${number}: ${result.documentName}, page ${result.pageNumber + 1}`}
          // Single-select among N, not a toggle.
          aria-current={active ? "true" : undefined}
          className={`inline-flex items-center justify-center rounded-full border text-2xs font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            label ? "px-1.5 py-0.5" : "size-5"
          } ${
            active
              ? "border-warning bg-warning/80 text-foreground"
              : "border-primary/25 bg-primary/5 text-foreground hover:border-primary hover:bg-primary hover:text-primary-foreground"
          }`}
        >
          {label ?? number}
        </button>
      </Tooltip>
    </span>
  );
}

function CitationPage({
  result,
  number,
  active,
  cardRef,
}: {
  result: ResearchResult;
  number: number;
  active: boolean;
  cardRef: (element: HTMLDivElement | null) => void;
}) {
  const pageDims = useQuery(api.pages.dimensionsByPage, {
    documentId: result.documentId,
    pageNumber: result.pageNumber,
  });
  const blocks = useQuery(api.blocks.byDocumentPage, {
    documentId: result.documentId,
    pageNumber: result.pageNumber,
  });
  const boxes = useMemo(
    () => matchingBoxes(blocks ?? [], result.snippet),
    [blocks, result.snippet]
  );

  const rotation = pageDims?.rotation ?? 0;
  const sourceWidth = pageDims?.width ?? PAGE_WIDTH;
  const sourceHeight = pageDims?.height ?? PAGE_WIDTH * (11 / 8.5);
  const sideways = rotation === 90 || rotation === 270;
  const scale = PAGE_WIDTH / (sideways ? sourceHeight : sourceWidth);
  const surfaceWidth = sourceWidth * scale;
  const surfaceHeight = sourceHeight * scale;
  const renderedHeight = sideways ? surfaceWidth : surfaceHeight;
  const coordinateScale = sourceWidth > 0 ? surfaceWidth / sourceWidth : 1;

  return (
    <article
      ref={cardRef}
      id={`citation-${number}`}
      data-citation-card={number}
      className={`w-[588px] shrink-0 snap-center overflow-hidden rounded-xl border bg-card shadow-sm transition-[border-color,box-shadow] ${
        active ? "border-amber-500 shadow-md shadow-amber-500/10" : ""
      }`}
    >
      <div className="flex items-center gap-2 border-b bg-card px-4 py-3">
        <span
          className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            active ? "bg-amber-400 text-amber-950" : "bg-muted text-foreground"
          }`}
        >
          {number}
        </span>
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {result.documentName}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          Page {result.pageNumber + 1}
        </span>
        {boxes.length > 1 && (
          <span className="shrink-0 rounded-full bg-amber-400/20 px-2 py-1 text-2xs font-medium text-amber-800 dark:text-amber-300">
            {boxes.length} matches on this page
          </span>
        )}
        <Link
          to={`/documents/${result.documentId}?page=${result.pageNumber + 1}&highlight=${encodeURIComponent(result.snippet)}`}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Open <ArrowUpRight className="size-3" />
        </Link>
      </div>

      <div className="bg-muted/50 p-5">
        <div
          className="relative mx-auto overflow-hidden rounded-sm bg-white shadow-lg"
          style={{ width: PAGE_WIDTH, height: renderedHeight }}
        >
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: surfaceWidth,
              height: surfaceHeight,
              transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
            }}
          >
            {/* A white page with the citation boxed on it. Pages are drawn
                client-side from the original file now, so there is no
                server-rendered raster to show here — the geometry is the
                point, and it is exact. */}
            {pageDims === undefined ? (
              <div className="absolute inset-0 animate-pulse bg-muted" />
            ) : (
              <div className="absolute inset-0 bg-white" />
            )}

            {active &&
              boxes.map((box) => (
                <span
                  key={box.id}
                  data-citation-highlight
                  className="pointer-events-none absolute z-10 rounded-sm border-2 border-amber-500 bg-amber-300/40 shadow-[0_0_0_2px_rgba(255,255,255,0.7)]"
                  style={{
                    left: box.x * coordinateScale,
                    top: box.y * coordinateScale,
                    width: box.width * coordinateScale,
                    height: box.height * coordinateScale,
                  }}
                />
              ))}
            {active && blocks !== undefined && boxes.length === 0 && (
              <span
                data-citation-highlight
                className="pointer-events-none absolute inset-2 z-10 rounded-sm border-4 border-amber-500 shadow-[inset_0_0_0_2px_rgba(255,255,255,0.75)]"
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export function ResearchAnswerWithEvidence({
  answer,
  results,
  projectId,
}: {
  answer: string;
  results: ResearchResult[];
  /** Whose citation style to render in. Null falls back to numbered sources. */
  projectId: Id<"projects"> | null;
}) {
  // Deduped: the same document can supply two evidence pages, and a
  // bibliography lists a source once however often it is cited.
  const citedDocumentIds = useMemo(
    () => [...new Set(results.map((r) => r.documentId))],
    [results]
  );
  const { formatter, style } = useCitations(projectId, citedDocumentIds);
  const inlineCitations = hasInlineCitations(style);
  const firstCitation = useMemo(() => {
    const first = answer.match(/\[(\d+)]/);
    const number = first ? Number(first[1]) : 1;
    return results[number - 1] ? number : 1;
  }, [answer, results]);
  const [activeCitation, setActiveCitation] = useState(firstCitation);
  const carouselRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<number, HTMLDivElement>());

  function centerCard(number: number, behavior: ScrollBehavior) {
    const carousel = carouselRef.current;
    const card = cardRefs.current.get(number);
    if (!carousel || !card) return;
    const carouselBox = carousel.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const desiredLeft = carouselBox.left + (carouselBox.width - cardBox.width) / 2;
    carousel.scrollBy({
      left: cardBox.left - desiredLeft,
      behavior,
    });
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => centerCard(firstCitation, "auto"));
    return () => cancelAnimationFrame(frame);
  }, [firstCitation]);

  function selectCitation(number: number) {
    if (!results[number - 1]) return;
    setActiveCitation(number);
    centerCard(number, "smooth");
  }

  const markdownComponents = {
    a({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
      const match = href?.match(/^#citation-(\d+)$/);
      if (!match) {
        return (
          <a href={href} {...props}>
            {children}
          </a>
        );
      }
      const number = Number(match[1]);
      const result = results[number - 1];
      if (!result) return <>{children}</>;
      return (
        <CitationButton
          number={number}
          label={inlineCitations ? formatter?.inText(number - 1) : undefined}
          result={result}
          active={activeCitation === number}
          onSelect={() => selectCitation(number)}
        />
      );
    },
  };

  return (
    <>
      <div className="max-w-3xl">
        <div className="prose prose-sm dark:prose-invert max-w-none mb-8 [&_p]:leading-relaxed">
          <ReactMarkdown components={markdownComponents}>
            {citationMarkdown(answer, formatter, inlineCitations)}
          </ReactMarkdown>
        </div>
      </div>

      {/* The bibliography, in the style's own order and format. Absent for a
          numbered project, where the evidence cards already are the list. */}
      {formatter && formatter.bibliography().length > 0 && (
        <section aria-labelledby="references-heading" className="mb-8 max-w-3xl">
          <h2 id="references-heading" className="text-sm font-semibold">
            References
          </h2>
          <ul className="mt-2 space-y-2">
            {formatter.bibliography().map((entry) => (
              <li
                key={entry.id}
                className="text-sm leading-relaxed text-muted-foreground"
              >
                {entry.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {results.length > 0 && (
        <section aria-labelledby="evidence-pages-heading" className="mb-4">
          <div className="mb-3 flex items-end gap-3">
            <div>
              <h2 id="evidence-pages-heading" className="text-sm font-semibold">
                Evidence pages
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Select a citation in the answer to highlight its source passage.
              </p>
            </div>
            <div className="ml-auto flex gap-1">
              <button
                type="button"
                onClick={() => selectCitation(Math.max(1, activeCitation - 1))}
                disabled={activeCitation === 1}
                className="inline-flex size-8 items-center justify-center rounded-full border bg-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Previous evidence page"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() =>
                  selectCitation(Math.min(results.length, activeCitation + 1))
                }
                disabled={activeCitation === results.length}
                className="inline-flex size-8 items-center justify-center rounded-full border bg-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Next evidence page"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>

          <div
            ref={carouselRef}
            className="flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain pb-4"
          >
            {results.map((result, index) => (
              <CitationPage
                key={`${result.documentId}:${result.pageNumber}:${index}`}
                result={result}
                number={index + 1}
                active={activeCitation === index + 1}
                cardRef={(element) => {
                  if (element) cardRefs.current.set(index + 1, element);
                  else cardRefs.current.delete(index + 1);
                }}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

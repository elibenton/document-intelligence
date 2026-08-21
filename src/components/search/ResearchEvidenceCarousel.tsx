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
// Answers are GFM markdown (the schema invites tables); core react-markdown
// is CommonMark-only, and without this plugin a table renders as a wall of
// literal pipes.
import remarkGfm from "remark-gfm";
import {
  ArrowUpRight,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  FileText,
  Globe,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useCitations } from "@/lib/citation/useCitations";
import { citationMarkdown, firstCitationNumber } from "@/lib/citation/markers";
import type { CitationStyle } from "../../../convex/projectTemplates";
import type { Id } from "../../../convex/_generated/dataModel";
import { Tooltip } from "@/components/ui/tooltip";
import { SinglePagePreview } from "@/components/viewer/SinglePagePreview";

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

interface EvidenceBlock {
  _id: string;
  text: string;
  bbox?: { x: number; y: number; width: number; height: number };
}

/**
 * The blocks on the page that carry the cited snippet — the shared scoring
 * behind both highlight styles: bbox blocks become boxes drawn on the page
 * image, bboxless blocks (web clips, transcripts) become highlighted runs in
 * the text excerpt.
 */
function matchingBlocks(blocks: EvidenceBlock[], snippet: string): EvidenceBlock[] {
  const target = normalizeText(snippet);
  if (!target) return [];
  const targetTokens = new Set(target.split(" "));
  const scored = blocks
    .filter((block) => normalizeText(block.text))
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
  // No blind fallback: highlighting the "closest" block when nothing truly
  // matches dressed fabricated citations up as corroborated ones. An empty
  // result renders as an explicit "passage not found" instead.
  const matches =
    containedMatches.length > 0
      ? containedMatches
      : scored.filter(({ score, shared }) => shared >= 3 && score >= 0.72);

  return matches.slice(0, 6).map(({ block }) => block);
}

function boxesOf(matches: EvidenceBlock[]): MatchBox[] {
  return matches
    .filter((block) => block.bbox)
    .map((block) => ({
      id: block._id,
      x: block.bbox!.x,
      y: block.bbox!.y,
      width: block.bbox!.width,
      height: block.bbox!.height,
    }));
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

/**
 * The extracted text of the cited page with the matched blocks highlighted —
 * the evidence rendering for media with no drawable page: web clips,
 * audio/video transcripts, DOCX. These used to render as a blank white
 * rectangle, because the page renderer only knew how to draw PDFs.
 */
function TextExcerpt({
  blocks,
  matchedIds,
  active,
  fallback,
}: {
  blocks: EvidenceBlock[];
  matchedIds: Set<string>;
  active: boolean;
  /** The result snippet, shown alone when the page has no stored blocks. */
  fallback: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Bring the cited passage into view when this card becomes the selection.
  // Scrolls the excerpt's own pane directly instead of scrollIntoView, which
  // would also yank the window and the carousel.
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>(
      "[data-citation-match]"
    );
    if (!container || !target) return;
    container.scrollTop =
      target.offsetTop - container.clientHeight / 2 + target.clientHeight / 2;
  }, [active, matchedIds]);

  return (
    <div
      ref={containerRef}
      className="relative max-h-[560px] overflow-y-auto bg-card px-6 py-5"
    >
      {blocks.length === 0 ? (
        <p
          className={`text-sm leading-relaxed ${
            active ? "rounded-sm bg-amber-300/40" : ""
          }`}
        >
          {fallback}
        </p>
      ) : (
        blocks.map((block) => {
          const hit = matchedIds.has(block._id);
          return (
            <p
              key={block._id}
              data-citation-match={hit || undefined}
              className={`my-2 text-sm leading-relaxed ${
                hit && active
                  ? "-mx-1 rounded-sm bg-amber-300/40 px-1"
                  : hit
                    ? "-mx-1 rounded-sm bg-muted px-1"
                    : "text-muted-foreground"
              }`}
            >
              {block.text}
            </p>
          );
        })
      )}
    </div>
  );
}

function CitationPage({
  result,
  file,
  number,
  active,
  cardRef,
}: {
  result: ResearchResult;
  /** Signed URL + media type of the original file, for drawing the page. */
  file: { url: string | null; mediaType?: string } | null;
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
  const matches = useMemo(
    () => matchingBlocks(blocks ?? [], result.snippet),
    [blocks, result.snippet]
  );
  const boxes = useMemo(() => boxesOf(matches), [matches]);
  const matchedIds = useMemo(
    () => new Set(matches.map((block) => block._id)),
    [matches]
  );

  // Pages that exist as pixels are drawn; everything else shows its text.
  const mediaType = file?.mediaType;
  const drawable = mediaType === "pdf" || mediaType === "image";
  const isTranscript = mediaType === "audio" || mediaType === "video";
  const SourceIcon =
    mediaType === "webScrape" ? Globe : isTranscript ? AudioLines : FileText;
  const contextLabel = drawable
    ? `Page ${result.pageNumber + 1}`
    : mediaType === "webScrape"
      ? "Web clip"
      : isTranscript
        ? "Transcript"
        : "Excerpt";

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
        <SourceIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {result.documentName}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {contextLabel}
        </span>
        {matches.length > 1 && (
          <span className="shrink-0 rounded-full bg-amber-400/20 px-2 py-1 text-2xs font-medium text-amber-800 dark:text-amber-300">
            {matches.length} matches on this page
          </span>
        )}
        <Link
          to={`/documents/${result.documentId}?page=${result.pageNumber + 1}&highlight=${encodeURIComponent(result.snippet)}`}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Open <ArrowUpRight className="size-3" />
        </Link>
      </div>

      {/* Honesty over theater: when the retrieval snippet can't be located in
          this page's stored blocks, say so instead of boxing the nearest
          lookalike. Web clips are exempt — their card shows the snippet
          itself, and the sandboxed iframe was never highlightable. */}
      {mediaType !== "webScrape" &&
        blocks !== undefined &&
        matches.length === 0 && (
          <div className="flex items-center gap-2 border-b bg-warning/10 px-4 py-2 text-xs text-muted-foreground">
            <TriangleAlert className="size-3.5 shrink-0 text-warning" />
            The cited passage couldn't be located on this page, so nothing is
            highlighted.
          </div>
        )}

      {drawable ? (
        <div className="bg-muted/50 p-5">
          <div
            className="mx-auto overflow-hidden rounded-sm bg-white shadow-lg"
            style={{ width: PAGE_WIDTH }}
          >
            {/* The page itself, drawn from the original file (pdf.js for a
                PDF, the image itself for an image), with the citation boxed
                on it. */}
            <SinglePagePreview
              fileUrl={file?.url ?? null}
              mediaType={file?.mediaType}
              pageNumber={result.pageNumber}
              width={PAGE_WIDTH}
              pageWidth={pageDims?.width}
              pageHeight={pageDims?.height}
              rotation={pageDims?.rotation ?? 0}
              overlay={(scale) => (
                <>
                  {active &&
                    boxes.map((box) => (
                      <span
                        key={box.id}
                        data-citation-highlight
                        className="absolute rounded-sm border-2 border-amber-500 bg-amber-300/40 shadow-[0_0_0_2px_rgba(255,255,255,0.7)]"
                        style={{
                          left: box.x * scale,
                          top: box.y * scale,
                          width: box.width * scale,
                          height: box.height * scale,
                        }}
                      />
                    ))}
                </>
              )}
            />
          </div>
        </div>
      ) : mediaType === "webScrape" && file?.url ? (
        // The archived snapshot itself, as on the document page. Sandboxed and
        // cross-origin, so the citation can't be highlighted inside it — the
        // cited passage rides above the frame instead.
        <div className="flex flex-col">
          <blockquote
            className={`border-b px-4 py-2.5 text-xs leading-relaxed ${
              active ? "bg-amber-300/40" : "bg-muted/50 text-muted-foreground"
            }`}
          >
            {result.snippet}
          </blockquote>
          <iframe
            src={file.url}
            title={`Archived snapshot: ${result.documentName}`}
            sandbox=""
            className="h-[480px] w-full border-0 bg-white"
          />
        </div>
      ) : (
        <TextExcerpt
          blocks={blocks ?? []}
          matchedIds={matchedIds}
          active={active}
          fallback={result.snippet}
        />
      )}
    </article>
  );
}

export function ResearchAnswerWithEvidence({
  answer,
  results,
  projectId,
  verification,
  retrieval,
}: {
  answer: string;
  results: ResearchResult[];
  /** Whose citation style to render in. Null falls back to numbered sources. */
  projectId: Id<"projects"> | null;
  /** What the post-synthesis check removed (convex/answerVerification.ts). */
  verification?: { totalClaims: number; removedClaims: string[] } | null;
  /** How much of the corpus was read, and which legs ran (convex/search.ts). */
  retrieval?: {
    candidates: number;
    used: number;
    semanticUnavailable?: string;
  } | null;
}) {
  // Deduped: the same document can supply two evidence pages, and a
  // bibliography lists a source once however often it is cited.
  const citedDocumentIds = useMemo(
    () => [...new Set(results.map((r) => r.documentId))],
    [results]
  );
  const { formatter, style } = useCitations(projectId, citedDocumentIds);
  // One batched subscription for the originals' signed URLs, so every evidence
  // card can draw its page client-side (see SinglePagePreview).
  const files = useQuery(
    api.documents.fileUrls,
    citedDocumentIds.length > 0 ? { ids: citedDocumentIds } : "skip"
  );
  const fileByDocument = useMemo(
    () => new Map((files ?? []).map((file) => [file._id, file])),
    [files]
  );
  const inlineCitations = hasInlineCitations(style);
  const firstCitation = useMemo(() => {
    const number = firstCitationNumber(answer) ?? 1;
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
    // Clicking a citation should land the reader on its evidence page: bring
    // the carousel into the viewport (a long answer pushes it below the fold),
    // then center the card within it. Not in centerCard — the on-load
    // auto-center must never scroll the window.
    carouselRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    centerCard(number, "smooth");
  }

  const markdownComponents = {
    // A wide table scrolls in its own pane instead of pushing the column out.
    table({ children, ...props }: ComponentPropsWithoutRef<"table">) {
      return (
        <div className="overflow-x-auto">
          <table {...props}>{children}</table>
        </div>
      );
    },
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
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {citationMarkdown(answer, formatter, inlineCitations)}
          </ReactMarkdown>
        </div>
      </div>

      {/* How much of the matching corpus this answer was written from. The
          synthesis cut has always been lossy; saying so is the difference
          between "this is the answer" and "this is the answer from what was
          read". Quiet by default — it is context, not a warning. */}
      {retrieval && retrieval.candidates > 0 && (
        <p className="mb-4 max-w-3xl text-xs text-muted-foreground">
          Answered from {retrieval.used} of {retrieval.candidates} matching{" "}
          {retrieval.candidates === 1 ? "passage" : "passages"}.
        </p>
      )}

      {/* A leg that could not run is a different fact, and does warrant a
          warning: without it the answer is written from keyword and entity
          matching alone while reading exactly as confident. */}
      {retrieval?.semanticUnavailable && (
        <div className="mb-8 max-w-3xl rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium">Semantic search was unavailable</p>
              <p className="text-muted-foreground">
                {retrieval.semanticUnavailable === "not_configured"
                  ? "No embeddings key is configured on this deployment, so this answer came from keyword and entity matching only."
                  : "The embeddings provider could not be reached, so this answer came from keyword and entity matching only. Check provider status in Settings."}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Disclosure of what the verification pass cut. Silence would read as
          "this is the whole answer"; the removed text stays inspectable so a
          wrongly-cut claim can be recognized and re-checked by a human. */}
      {verification && verification.removedClaims.length > 0 && (
        <div className="mb-8 max-w-3xl rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium">
                {verification.removedClaims.length} of{" "}
                {verification.totalClaims} cited{" "}
                {verification.totalClaims === 1 ? "claim" : "claims"} removed
              </p>
              <p className="text-muted-foreground">
                These sentences cited pages that don't contain what they say,
                so they were cut from the answer rather than shown as fact.
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                  Show removed text
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {verification.removedClaims.map((claim, i) => (
                    <li
                      key={i}
                      className="text-xs leading-relaxed text-muted-foreground"
                    >
                      {claim}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          </div>
        </div>
      )}

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
                file={fileByDocument.get(result.documentId) ?? null}
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

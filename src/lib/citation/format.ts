import type { CitationStyle } from "../../../convex/projectTemplates";
import { toCslItem, type CitationSource, type CslItem } from "./cslItem";

/**
 * Formatting a set of cited documents in a project's citation style.
 *
 * The engine and its style sheets are ~700KB together (Chicago 18th alone is
 * 242KB of XML), so nothing here is imported at module load. `loadFormatter`
 * pulls them in with a dynamic `import()` the first time a non-numeric style is
 * actually rendered — which for the default project is never.
 *
 * **Licence.** `citeproc` (citeproc-js) is CPAL-1.0 OR AGPL-1.0, and the CSL
 * style sheets in ./styles are CC BY-SA 3.0. Both are copyleft; see
 * ./styles/README.md. This was a deliberate choice — the alternative was
 * hand-writing three formatters, and Chicago in particular is not a fight worth
 * picking.
 */

export interface Formatter {
  /** What replaces the `[n]` marker in the answer text. */
  inText(index: number): string;
  /** The reference list, in the style's own order, as one entry per source. */
  bibliography(): Array<{ id: string; text: string }>;
}

/** citeproc has no types; this is the surface actually used. */
interface CiteprocEngine {
  updateItems(ids: string[]): void;
  processCitationCluster(
    citation: unknown,
    citationsPre: unknown[],
    citationsPost: unknown[]
  ): [unknown, Array<[number, string, string]>];
  makeBibliography(): [{ entry_ids: string[][] }, string[]];
}

/** One engine per style, kept because building one parses the whole style. */
const engines = new Map<string, unknown>();

async function styleXml(style: CitationStyle): Promise<string> {
  switch (style) {
    case "apa":
      return (await import("./styles/apa.csl?raw")).default;
    case "chicago":
      return (await import("./styles/chicago-notes-bibliography.csl?raw")).default;
    case "mla":
      return (await import("./styles/modern-language-association.csl?raw")).default;
    default:
      throw new Error(`No style sheet for ${style}`);
  }
}

/**
 * A formatter for these sources in this style, or null for `numeric` — which
 * is not a CSL style at all but the app's own numbered-source rendering, and
 * needs no engine.
 */
export async function loadFormatter(
  style: CitationStyle,
  sources: CitationSource[]
): Promise<Formatter | null> {
  if (style === "numeric" || sources.length === 0) return null;

  const [{ default: CSL }, locale, xml] = await Promise.all([
    import("citeproc"),
    import("./styles/locales-en-US.xml?raw").then((m) => m.default),
    styleXml(style),
  ]);

  const items = new Map<string, CslItem>();
  for (const source of sources) {
    const item = toCslItem(source);
    items.set(item.id, item);
  }
  const ids = [...items.keys()];

  // citeproc's `sys` is synchronous by contract, which is the whole reason the
  // locale is bundled as a raw string rather than fetched when asked for.
  const sys = {
    retrieveLocale: () => locale,
    retrieveItem: (id: string) => items.get(id),
  };

  const key = `${style}:${ids.join(",")}`;
  let engine = engines.get(key) as CiteprocEngine | undefined;
  if (!engine) {
    engine = new (CSL as unknown as { Engine: new (sys: unknown, style: string) => CiteprocEngine }).Engine(
      sys,
      xml
    );
    engines.set(key, engine);
  }
  engine.updateItems(ids);

  // Rendered once, up front: every in-text form is a function of the whole set
  // (a numbered style numbers by position, an author-date style disambiguates
  // two authors with the same surname against each other).
  //
  // `pre` accumulates. Passing an empty citationsPre on every call tells
  // citeproc each cluster is the only one in the document, which discards the
  // clusters before it — the bibliography then contains just the last source
  // cited. Measured, not guessed: three sources produced one reference.
  const pre: Array<[string, number]> = [];
  const inTextByIndex: string[] = ids.map((id, index) => {
    const citationId = `c${index}`;
    const noteIndex = index + 1;
    try {
      const [, results] = engine!.processCitationCluster(
        {
          citationID: citationId,
          citationItems: [{ id }],
          properties: { noteIndex },
        },
        pre.slice(),
        []
      );
      pre.push([citationId, noteIndex]);
      // Matched by citationID, not by position. The result array is indexed by
      // each cluster's position in the whole document, so once `pre` is
      // non-empty the new cluster is no longer at 0 — looking for 0 returned
      // nothing for every citation after the first.
      const rendered = results.find(([, , id]) => id === citationId);
      return rendered ? decodeEntities(stripTags(rendered[1])) : `[${noteIndex}]`;
    } catch {
      // A style that cannot render this item is not a reason to lose the
      // answer — fall back to the marker the model actually wrote.
      return `[${noteIndex}]`;
    }
  });

  return {
    inText: (index) => inTextByIndex[index] ?? `[${index + 1}]`,
    bibliography: () => {
      try {
        const [meta, entries] = engine!.makeBibliography();
        // Driven by `entries`, not `entry_ids`. The two are NOT parallel:
        // citeproc lists an id for every item it knows about but emits a string
        // only for the ones the style can actually lay out, so a style that
        // renders nothing for an item returns entry_ids.length 1 against
        // entries.length 0. Indexing entry_ids into entries produced a
        // reference list of empty bullets — seven of them, in the first run
        // against a real answer.
        return entries
          .map((html, i) => ({
            id: meta.entry_ids[i]?.[0] ?? String(i),
            text: decodeEntities(stripTags(html)),
          }))
          .filter((entry) => entry.text.length > 0);
      } catch {
        return [];
      }
    },
  };
}

/** citeproc returns HTML fragments. The reference list renders as text, so the
 *  markup comes off here rather than being injected. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * citeproc escapes for HTML output, so an ampersand arrives as `&#38;`. Since
 * these strings are rendered as text, the escaping has to come back off or APA
 * prints "Department of Food and Agriculture &#38; Franwell, Inc." — observed
 * in the first render of real data.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Last: an escaped entity like &amp;#38; must not decode twice.
    .replace(/&amp;/g, "&");
}

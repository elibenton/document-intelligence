/**
 * Text-quote anchoring for web clip highlights.
 *
 * The archived page reflows with the pane, so highlights anchor by the
 * selected text itself (plus a little context to disambiguate repeats) and
 * are re-found in the rendered document at paint — the same idea Hypothesis
 * and the W3C annotation model use.
 */

import { KEEP } from "../../../convex/nameMatch";

export interface QuoteAnchor {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** How much surrounding text is stored to disambiguate repeated passages. */
const CONTEXT_CHARS = 32;

/** Flat view of a document's visible text: one string plus the text nodes
 *  that produced it, so a global offset maps back to (node, local offset). */
export interface TextIndex {
  text: string;
  nodes: { node: Text; start: number }[];
}

export function buildTextIndex(doc: Document): TextIndex {
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("style, script, noscript, template")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += (node as Text).data;
  }
  return { text, nodes };
}

/** Global offset of a (node, local offset) position, or null for a position
 *  outside the indexed text (e.g. inside an element the walker rejected). */
function globalOffset(index: TextIndex, node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const entry = index.nodes.find((n) => n.node === node);
    return entry ? entry.start + offset : null;
  }
  // An element boundary: resolve to the first indexed text at or after the
  // child the offset points at.
  const children = node.childNodes;
  for (let i = offset; i < children.length; i++) {
    const walker = (node.ownerDocument ?? (node as Document)).createTreeWalker(
      children[i],
      NodeFilter.SHOW_TEXT
    );
    const first = walker.nextNode();
    if (first) {
      const entry = index.nodes.find((n) => n.node === first);
      if (entry) return entry.start;
    }
  }
  return null;
}

/** Describe a DOM selection range as a quote anchor, or null when the range
 *  doesn't land in indexed text or selects nothing. */
export function quoteFromRange(index: TextIndex, range: Range): QuoteAnchor | null {
  const start = globalOffset(index, range.startContainer, range.startOffset);
  const end = globalOffset(index, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  const exact = index.text.slice(start, end);
  if (!exact.trim()) return null;
  return {
    exact,
    prefix: index.text.slice(Math.max(0, start - CONTEXT_CHARS), start) || undefined,
    suffix: index.text.slice(end, end + CONTEXT_CHARS) || undefined,
  };
}

/** Map a global offset back to (text node, local offset). */
function positionAt(index: TextIndex, offset: number): { node: Text; offset: number } | null {
  for (let i = index.nodes.length - 1; i >= 0; i--) {
    const entry = index.nodes[i];
    if (offset >= entry.start) {
      const local = offset - entry.start;
      if (local <= entry.node.data.length) return { node: entry.node, offset: local };
      return null;
    }
  }
  return null;
}

/** Re-find a stored quote in the document and build a Range over it, or null
 *  when the text is no longer present (a different archive was stored, or the
 *  passage sat in content the index skips). */
/** Lowercase-alphanumeric view of a string (blockSearch's normalization),
 *  with each kept character mapped back to its source offset. Per-character
 *  NFKC keeps that map exact when a ligature expands. */
function normalizeChars(source: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    for (const char of source[i].normalize("NFKC")) {
      if (!KEEP.test(char)) continue;
      norm += char.toLowerCase();
      map.push(i);
    }
  }
  return { norm, map };
}

/**
 * Find a passage by *normalized* text — for jumping to a search hit. The
 * search panel's hits come from the extracted block text, whose whitespace
 * and entity spellings drift from the archive DOM's, so the exact matching
 * rangeFromQuote does would miss; here both sides reduce to lowercase
 * alphanumerics first, the same normalization blockSearch matched with.
 * Candidates are tried in order (snippet first — long enough to be unique —
 * then the bare match text); the first one found wins.
 */
export function rangeFromSearchText(
  doc: Document,
  index: TextIndex,
  candidates: string[]
): Range | null {
  const { norm, map } = normalizeChars(index.text);
  for (const candidate of candidates) {
    const wanted = normalizeChars(candidate).norm;
    if (!wanted) continue;
    const at = norm.indexOf(wanted);
    if (at < 0) continue;
    const from = positionAt(index, map[at]);
    const to = positionAt(index, map[at + wanted.length - 1] + 1);
    if (!from || !to) continue;
    const range = doc.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  }
  return null;
}

export function rangeFromQuote(
  doc: Document,
  index: TextIndex,
  quote: QuoteAnchor
): Range | null {
  let start = -1;
  if (quote.prefix) {
    const withPrefix = index.text.indexOf(quote.prefix + quote.exact);
    if (withPrefix >= 0) start = withPrefix + quote.prefix.length;
  }
  if (start < 0) start = index.text.indexOf(quote.exact);
  if (start < 0) return null;
  const from = positionAt(index, start);
  const to = positionAt(index, start + quote.exact.length);
  if (!from || !to) return null;
  const range = doc.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

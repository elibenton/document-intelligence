/**
 * Lightweight DOCX reading and page layout — pure functions, no Node builtins,
 * so this module is unit-testable and safe to import from either runtime.
 *
 * Scope is deliberately small: WordprocessingML paragraphs (including the ones
 * inside tables), their heading/list style, and their page breaks. This is a
 * *viewer* renderer — it produces page images and text geometry so DOCX uploads
 * behave like PDFs in the reader. Interfaze still receives the untouched
 * original and remains canonical for OCR text and detections.
 *
 * Pagination honours Word's own `lastRenderedPageBreak`/explicit page breaks
 * when the file has them, so our page numbers line up with what Interfaze sees.
 * Files without those markers (many generated documents) fall back to flowing
 * text at letter size, which is an approximation, not the authoritative
 * pagination.
 */

export type DocxStyle = "h1" | "h2" | "h3" | "body";

export type DocxParagraph = {
  text: string;
  style: DocxStyle;
  /** Present for list paragraphs; the value is the (0-based) indent level. */
  listLevel?: number;
  /** True when a hard or Word-rendered page break precedes this paragraph. */
  pageBreakBefore: boolean;
};

export type LayoutWord = { text: string; x: number; width: number };

export type LayoutLine = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontPx: number;
  bold: boolean;
  words: LayoutWord[];
};

export type LayoutPage = {
  width: number;
  height: number;
  lines: LayoutLine[];
};

/** Text measurement, injected so layout stays free of any canvas dependency. */
export type MeasureText = (text: string, fontPx: number, bold: boolean) => number;

// US Letter at ~188 dpi, matching the PDF renderer's 1600px target width.
export const PAGE_WIDTH = 1600;
export const PAGE_HEIGHT = 2071;
export const PAGE_MARGIN = 188;
export const BODY_FONT_PX = 30;

const STYLE_FONT_PX: Record<DocxStyle, number> = {
  h1: 52,
  h2: 42,
  h3: 36,
  body: BODY_FONT_PX,
};
const LINE_HEIGHT_RATIO = 1.45;
const PARAGRAPH_GAP_RATIO = 0.55;
const LIST_INDENT_PX = 56;
const BULLET = "• ";

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") || entity.startsWith("#X")
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function styleOf(properties: string): DocxStyle {
  const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(properties)?.[1] ?? "";
  const normalized = style.toLowerCase().replace(/[\s_-]/g, "");
  if (normalized === "title" || normalized === "heading1") return "h1";
  if (normalized === "heading2" || normalized === "subtitle") return "h2";
  if (normalized === "heading3") return "h3";
  return "body";
}

/**
 * Extract paragraphs from a `word/document.xml` body.
 *
 * Table cells contain ordinary `<w:p>` elements, so flattening picks their text
 * up as separate paragraphs — cell-grid geometry is out of scope for a
 * lightweight renderer, but no text is dropped.
 */
export function parseDocumentXml(xml: string): DocxParagraph[] {
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  // Field instructions and deleted (tracked-change) runs are not visible text.
  const cleaned = body
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, "")
    .replace(/<w:delText\b[\s\S]*?<\/w:delText>/g, "");

  const paragraphs: DocxParagraph[] = [];
  let pendingBreak = false;
  const paragraphPattern = /<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;

  for (const match of cleaned.matchAll(paragraphPattern)) {
    const content = match[1] ?? "";
    const properties = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(content)?.[1] ?? "";
    const style = styleOf(properties);
    const numbering = /<w:numPr\b/.test(properties);
    const listLevel = numbering
      ? Number(/<w:ilvl\b[^>]*w:val="(\d+)"/.exec(properties)?.[1] ?? 0)
      : undefined;
    if (/<w:pageBreakBefore\b(?![^>]*w:val="(?:0|false)")/.test(properties)) {
      pendingBreak = true;
    }

    // Walk the runs in document order so tabs, breaks and text interleave
    // correctly, and so a mid-paragraph page break splits the paragraph.
    const tokens =
      /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:lastRenderedPageBreak\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
    let buffer = "";
    let breakBefore = pendingBreak;
    pendingBreak = false;
    const flush = () => {
      const text = buffer.replace(/[ \t]+$/gm, "").trim();
      if (text.length > 0 || breakBefore) {
        paragraphs.push({ text, style, listLevel, pageBreakBefore: breakBefore });
        breakBefore = false;
      }
      buffer = "";
    };

    for (const token of content.matchAll(tokens)) {
      const raw = token[0];
      if (token[1] !== undefined) {
        buffer += unescapeXml(token[1]);
      } else if (raw.startsWith("<w:tab")) {
        buffer += "\t";
      } else if (raw.startsWith("<w:lastRenderedPageBreak")) {
        flush();
        breakBefore = true;
      } else if (/w:type="page"/.test(raw)) {
        flush();
        breakBefore = true;
      } else {
        buffer += "\n";
      }
    }
    flush();
  }

  // A trailing break marker with no following text is not a page.
  return paragraphs.filter(
    (paragraph, index) =>
      paragraph.text.length > 0 || index < paragraphs.length - 1
  );
}

function wrap(
  text: string,
  fontPx: number,
  bold: boolean,
  maxWidth: number,
  measure: MeasureText
): string[] {
  const lines: string[] = [];
  for (const segment of text.split("\n")) {
    const words = segment.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && measure(candidate, fontPx, bold) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

function layoutWords(
  line: string,
  x: number,
  fontPx: number,
  bold: boolean,
  measure: MeasureText
): LayoutWord[] {
  const words: LayoutWord[] = [];
  let cursor = x;
  let consumed = 0;
  for (const match of line.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    // Advance the cursor across the whitespace that precedes this word.
    cursor += measure(line.slice(consumed, start), fontPx, bold);
    const width = measure(match[0], fontPx, bold);
    words.push({ text: match[0], x: cursor, width });
    cursor += width;
    consumed = start + match[0].length;
  }
  return words;
}

/**
 * Flow paragraphs into pages. Explicit page breaks always start a new page;
 * within a page, text wraps and overflows onto continuation pages so nothing is
 * clipped. A page carrying more content than a letter sheet (only reachable
 * when Word's own breaks say so) grows instead of losing text.
 */
export function layoutDocument(
  paragraphs: DocxParagraph[],
  measure: MeasureText
): LayoutPage[] {
  const contentWidth = PAGE_WIDTH - PAGE_MARGIN * 2;
  const maxY = PAGE_HEIGHT - PAGE_MARGIN;
  const pages: LayoutPage[] = [];
  let lines: LayoutLine[] = [];
  let y = PAGE_MARGIN;
  let hardBreakPage = false;

  const commit = (nextPageIsHardBreak: boolean) => {
    const bottom = lines.reduce(
      (max, line) => Math.max(max, line.y + line.height),
      PAGE_MARGIN
    );
    pages.push({
      width: PAGE_WIDTH,
      height: Math.max(PAGE_HEIGHT, Math.ceil(bottom + PAGE_MARGIN)),
      lines,
    });
    lines = [];
    y = PAGE_MARGIN;
    hardBreakPage = nextPageIsHardBreak;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.pageBreakBefore && lines.length > 0) commit(true);
    if (paragraph.text.length === 0) continue;

    const fontPx = STYLE_FONT_PX[paragraph.style];
    const bold = paragraph.style !== "body";
    const lineHeight = Math.round(fontPx * LINE_HEIGHT_RATIO);
    const indent =
      paragraph.listLevel === undefined
        ? 0
        : LIST_INDENT_PX * (paragraph.listLevel + 1);
    const x = PAGE_MARGIN + indent;
    const width = contentWidth - indent;
    const wrapped = wrap(paragraph.text, fontPx, bold, width, measure);

    wrapped.forEach((line, index) => {
      const text =
        paragraph.listLevel !== undefined && index === 0
          ? `${BULLET}${line}`
          : line;
      // Overflow onto a new page unless Word's own break defined this one, in
      // which case the page grows rather than contradicting the source.
      if (!hardBreakPage && y + lineHeight > maxY && lines.length > 0) {
        commit(false);
      }
      if (text.length > 0) {
        lines.push({
          text,
          x,
          y,
          width: Math.min(measure(text, fontPx, bold), width),
          height: lineHeight,
          fontPx,
          bold,
          words: layoutWords(text, x, fontPx, bold, measure),
        });
      }
      y += lineHeight;
    });
    y += Math.round(fontPx * PARAGRAPH_GAP_RATIO);
  }

  if (lines.length > 0 || pages.length === 0) commit(false);
  return pages;
}

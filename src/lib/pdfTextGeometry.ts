export interface TextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextWord {
  text: string;
  bbox?: TextBox;
  confidence?: number;
}

export interface TextBlock {
  _id: string;
  blockId: string;
  text: string;
  bbox?: TextBox;
  words?: TextWord[];
  confidence?: number;
  readingOrder?: number;
}

export type TokenSeparator = "none" | "space" | "line" | "page";

export interface PageTextToken {
  id: string;
  blockId: string;
  text: string;
  bbox: TextBox;
  confidence?: number;
  separatorBefore: TokenSeparator;
}

interface TokenCandidate extends Omit<PageTextToken, "separatorBefore"> {
  sourceOrder: number;
}

interface Segment {
  tokens: TokenCandidate[];
  bbox: TextBox;
}

interface Row {
  segments: Segment[];
  bbox: TextBox;
}

const punctuationWithoutLeadingSpace = /^[,.;:!?%)}\]]/;
const punctuationWithoutTrailingSpace = /[(¿¡{[]$/;

function finiteBox(box: TextBox | undefined): box is TextBox {
  return Boolean(
    box &&
      Number.isFinite(box.x) &&
      Number.isFinite(box.y) &&
      Number.isFinite(box.width) &&
      Number.isFinite(box.height) &&
      box.width > 0.25 &&
      box.height > 0.25
  );
}

function normalizedBox(
  box: TextBox | undefined,
  pageWidth: number,
  pageHeight: number
): TextBox | null {
  if (!finiteBox(box) || pageWidth <= 0 || pageHeight <= 0) return null;
  const toleranceX = Math.max(2, pageWidth * 0.01);
  const toleranceY = Math.max(2, pageHeight * 0.01);
  if (
    box.x < -toleranceX ||
    box.y < -toleranceY ||
    box.x + box.width > pageWidth + toleranceX ||
    box.y + box.height > pageHeight + toleranceY
  ) {
    return null;
  }

  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  return {
    x,
    y,
    width: Math.min(box.width, pageWidth - x),
    height: Math.min(box.height, pageHeight - y),
  };
}

function unionBoxes(boxes: TextBox[]): TextBox {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
  };
}

function verticalOverlap(a: TextBox, b: TextBox): number {
  const overlap =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap > 0 ? overlap / Math.min(a.height, b.height) : 0;
}

function estimatedWordBoxes(words: TextWord[], block: TextBox): TextBox[] {
  const weights = words.map((word) => Math.max(1, word.text.trim().length));
  const spaces = Math.max(0, words.length - 1);
  const total = weights.reduce((sum, weight) => sum + weight, spaces);
  let cursor = 0;
  return weights.map((weight, index) => {
    const x = block.x + (block.width * cursor) / total;
    cursor += weight;
    const width = (block.width * weight) / total;
    cursor += index < weights.length - 1 ? 1 : 0;
    return { x, y: block.y, width, height: block.height };
  });
}

function blockCandidates(
  block: TextBlock,
  blockIndex: number,
  pageWidth: number,
  pageHeight: number
): TokenCandidate[] {
  const blockBox = normalizedBox(block.bbox, pageWidth, pageHeight);
  const words = block.words?.filter((word) => word.text.trim()) ?? [];
  if (words.length > 0) {
    const estimates = blockBox ? estimatedWordBoxes(words, blockBox) : [];
    const candidates = words.flatMap((word, wordIndex) => {
      const bbox =
        normalizedBox(word.bbox, pageWidth, pageHeight) ??
        estimates[wordIndex] ??
        null;
      if (!bbox) return [];
      return [{
        id: `${block.blockId}:w${wordIndex}`,
        blockId: block.blockId,
        text: word.text.trim(),
        bbox,
        confidence: word.confidence ?? block.confidence,
        sourceOrder: (block.readingOrder ?? blockIndex) * 10_000 + wordIndex,
      }];
    });
    if (candidates.length > 0) return candidates;
  }

  const text = block.text.trim();
  return text && blockBox
    ? [{
        id: `${block.blockId}:line`,
        blockId: block.blockId,
        text,
        bbox: blockBox,
        confidence: block.confidence,
        sourceOrder: (block.readingOrder ?? blockIndex) * 10_000,
      }]
    : [];
}

function rowSegments(tokens: TokenCandidate[], pageWidth: number): Row[] {
  const rows: Array<{ tokens: TokenCandidate[]; bbox: TextBox }> = [];
  for (const token of [...tokens].sort(
    (a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x
  )) {
    const center = token.bbox.y + token.bbox.height / 2;
    let best: (typeof rows)[number] | undefined;
    let bestScore = 0;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row.bbox.y + row.bbox.height < token.bbox.y - token.bbox.height) {
        break;
      }
      const rowCenter = row.bbox.y + row.bbox.height / 2;
      const centerDistance = Math.abs(center - rowCenter);
      const score = verticalOverlap(token.bbox, row.bbox);
      if (
        score > bestScore &&
        (score >= 0.45 ||
          centerDistance <= Math.min(token.bbox.height, row.bbox.height) * 0.4)
      ) {
        best = row;
        bestScore = score;
      }
    }
    if (best) {
      best.tokens.push(token);
      best.bbox = unionBoxes(best.tokens.map((entry) => entry.bbox));
    } else {
      rows.push({ tokens: [token], bbox: token.bbox });
    }
  }

  return rows
    .map((row) => {
      const ordered = row.tokens.sort(
        (a, b) => a.bbox.x - b.bbox.x || a.sourceOrder - b.sourceOrder
      );
      const segments: Segment[] = [];
      for (const token of ordered) {
        const previous = segments.at(-1);
        const previousToken = previous?.tokens.at(-1);
        const gap = previousToken
          ? token.bbox.x - (previousToken.bbox.x + previousToken.bbox.width)
          : 0;
        const segmentGap = Math.max(
          pageWidth * 0.045,
          Math.max(token.bbox.height, previousToken?.bbox.height ?? 0) * 3
        );
        if (!previous || gap > segmentGap) {
          segments.push({ tokens: [token], bbox: token.bbox });
        } else {
          previous.tokens.push(token);
          previous.bbox = unionBoxes(previous.tokens.map((entry) => entry.bbox));
        }
      }
      return { segments, bbox: unionBoxes(segments.map((segment) => segment.bbox)) };
    })
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
}

function primaryGutter(rows: Row[], pageWidth: number) {
  const tokens = rows.flatMap((row) =>
    row.segments.flatMap((segment) => segment.tokens)
  );
  const interior = Array.from({ length: 96 }, (_, index) => {
    const x = pageWidth * (0.15 + (index / 95) * 0.7);
    return {
      x,
      count: tokens.filter(
        (token) => token.bbox.x <= x && token.bbox.x + token.bbox.width >= x
      ).length,
    };
  });
  const counts = interior.map((sample) => sample.count).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  const lowSamples = interior.filter(
    (sample) => median >= 4 && sample.count <= median * 0.4
  );
  const valleys: typeof lowSamples[] = [];
  for (const sample of lowSamples) {
    const current = valleys.at(-1);
    const step = (pageWidth * 0.7) / 95;
    if (!current || sample.x - current.at(-1)!.x > step * 1.5) {
      valleys.push([sample]);
    } else {
      current.push(sample);
    }
  }
  const valley = valleys.sort((a, b) => b.length - a.length)[0];
  if (valley) {
    const cut = valley.reduce((sum, sample) => sum + sample.x, 0) / valley.length;
    const supportedRows = rows.filter((row) => {
      const rowTokens = row.segments.flatMap((segment) => segment.tokens);
      return (
        rowTokens.some((token) => token.bbox.x + token.bbox.width <= cut) &&
        rowTokens.some((token) => token.bbox.x >= cut)
      );
    }).length;
    if (supportedRows >= Math.max(3, Math.ceil(rows.length * 0.12))) {
      const halfWidth = Math.max(1, pageWidth * 0.004);
      return { start: cut - halfWidth, end: cut + halfWidth };
    }
  }

  const gaps = rows.flatMap((row) =>
    row.segments.slice(1).flatMap((segment, index) => {
      const previous = row.segments[index];
      const start = previous.bbox.x + previous.bbox.width;
      const end = segment.bbox.x;
      return end - start >= pageWidth * 0.05
        ? [{ start, end, center: (start + end) / 2 }]
        : [];
    })
  );
  if (gaps.length < 2) return null;

  const candidates = gaps.map((seed) => {
    const matches = gaps.filter(
      (gap) => Math.abs(gap.center - seed.center) <= pageWidth * 0.08
    );
    return {
      count: matches.length,
      start: Math.max(...matches.map((gap) => gap.start)),
      end: Math.min(...matches.map((gap) => gap.end)),
    };
  });
  const best = candidates.sort(
    (a, b) => b.count - a.count || b.end - b.start - (a.end - a.start)
  )[0];
  if (
    best.count < Math.max(2, Math.ceil(rows.length * 0.12)) ||
    best.end <= best.start ||
    best.start < pageWidth * 0.12 ||
    best.end > pageWidth * 0.88
  ) {
    return null;
  }
  return { start: best.start, end: best.end };
}

function orderedSegments(rows: Row[], pageWidth: number): Segment[] {
  const gutter = primaryGutter(rows, pageWidth);
  if (!gutter) return rows.flatMap((row) => row.segments);

  const output: Segment[] = [];
  let columnBand: Segment[] = [];
  const tokenHeights = rows
    .flatMap((row) => row.segments.flatMap((segment) => segment.tokens))
    .map((token) => token.bbox.height)
    .sort((a, b) => a - b);
  const medianHeight = tokenHeights[Math.floor(tokenHeights.length / 2)] ?? 1;
  const cut = (gutter.start + gutter.end) / 2;
  const rowTokenCounts: number[] = [];
  const columnCandidates = rows.map((row) => {
    const rowTokens = row.segments.flatMap((segment) => segment.tokens);
    rowTokenCounts.push(rowTokens.length);
    return (
      row.bbox.height <= medianHeight * 1.5 &&
      rowTokens.length >= 2 &&
      rowTokens.some(
        (token) => token.bbox.x + token.bbox.width / 2 < cut
      ) &&
      rowTokens.some(
        (token) => token.bbox.x + token.bbox.width / 2 >= cut
      )
    );
  });
  let columnStart = rows.length;
  for (const minimumTokens of [6, 2]) {
    for (let index = 0; index < columnCandidates.length - 1; index++) {
      if (
        columnCandidates[index] &&
        columnCandidates[index + 1] &&
        rowTokenCounts[index] >= minimumTokens &&
        rowTokenCounts[index + 1] >= minimumTokens
      ) {
        columnStart = index;
        break;
      }
    }
    if (columnStart < rows.length) break;
  }
  const flushColumns = () => {
    const left = columnBand.filter(
      (segment) => segment.bbox.x + segment.bbox.width / 2 < cut
    );
    const right = columnBand.filter(
      (segment) => segment.bbox.x + segment.bbox.width / 2 >= cut
    );
    const middle = columnBand.filter(
      (segment) => !left.includes(segment) && !right.includes(segment)
    );
    const topLeft = (a: Segment, b: Segment) =>
      a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x;
    output.push(...left.sort(topLeft), ...right.sort(topLeft), ...middle.sort(topLeft));
    columnBand = [];
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const rowTokens = row.segments.flatMap((segment) => segment.tokens);
    const spanning =
      rowIndex < columnStart ||
      row.bbox.height > medianHeight * 1.65 ||
      rowTokens.some(
        (token) =>
          token.bbox.width > pageWidth * 0.25 &&
          token.bbox.x < gutter.end &&
          token.bbox.x + token.bbox.width > gutter.start
      );
    if (spanning) {
      flushColumns();
      output.push(...row.segments);
      continue;
    }

    const leftTokens = rowTokens.filter(
      (token) => token.bbox.x + token.bbox.width / 2 < cut
    );
    const rightTokens = rowTokens.filter(
      (token) => token.bbox.x + token.bbox.width / 2 >= cut
    );
    if (leftTokens.length > 0) {
      columnBand.push({
        tokens: leftTokens,
        bbox: unionBoxes(leftTokens.map((token) => token.bbox)),
      });
    }
    if (rightTokens.length > 0) {
      columnBand.push({
        tokens: rightTokens,
        bbox: unionBoxes(rightTokens.map((token) => token.bbox)),
      });
    }
  }
  flushColumns();
  return output;
}

function inlineSeparator(previous: string, current: string): TokenSeparator {
  return punctuationWithoutLeadingSpace.test(current) ||
    punctuationWithoutTrailingSpace.test(previous)
    ? "none"
    : "space";
}

/**
 * Convert either OCR line blocks or native PDF text items into one validated,
 * word-level stream with deterministic column-aware reading order.
 */
export function buildPageTextTokens(
  blocks: TextBlock[],
  pageWidth: number,
  pageHeight: number
): PageTextToken[] {
  const candidates = blocks.flatMap((block, index) =>
    blockCandidates(block, index, pageWidth, pageHeight)
  );
  if (candidates.length === 0) return [];

  const segments = orderedSegments(rowSegments(candidates, pageWidth), pageWidth);
  const tokens: PageTextToken[] = [];
  for (const segment of segments) {
    for (let index = 0; index < segment.tokens.length; index++) {
      const candidate = segment.tokens[index];
      const previous = tokens.at(-1);
      const previousInSegment = index > 0 ? previous : undefined;
      tokens.push({
        ...candidate,
        separatorBefore: previousInSegment
          ? inlineSeparator(previousInSegment.text, candidate.text)
          : previous
            ? "line"
            : "none",
      });
    }
  }
  return tokens;
}

export function separatorText(separator: TokenSeparator): string {
  if (separator === "space") return " ";
  if (separator === "line") return "\n";
  if (separator === "page") return "\n\n";
  return "";
}

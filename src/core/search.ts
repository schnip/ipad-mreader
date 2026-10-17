export interface SearchTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** pdf.js reports that this item ends a line of text. */
  endOfLine?: boolean;
}

export interface SearchPageText {
  pageNumber: number;
  width: number;
  height: number;
  items: SearchTextItem[];
}

export interface SearchHit {
  pageNumber: number;
  context: string;
  itemIndexes: number[];
  segments: { itemIndex: number; startOffset: number; endOffset: number }[];
}

export interface SearchProgress {
  scanned: number;
  total: number;
  hits: SearchHit[];
  matchCount: number;
  textPages: number;
  /** Pages whose text could not be extracted; they are skipped, not fatal. */
  failedPages: number;
  done: boolean;
  cancelled: boolean;
}

export function transformedTextBounds(
  textTransform: readonly unknown[],
  viewportTransform: readonly unknown[],
  textWidth: number,
  textHeight: number
): Omit<SearchTextItem, "text"> {
  const text = matrix(textTransform);
  const viewport = matrix(viewportTransform);
  const combined = multiply(viewport, text);
  const angle = Math.atan2(combined[1], combined[0]);
  const viewportScale = Math.max(Number.EPSILON, Math.hypot(viewport[0], viewport[1]));
  const width = Math.max(0, textWidth) * viewportScale;
  const height = Math.max(1, textHeight * viewportScale, Math.hypot(combined[2], combined[3]));
  const widthVector = { x: Math.cos(angle) * width, y: Math.sin(angle) * width };
  const heightVector = { x: Math.sin(angle) * height, y: -Math.cos(angle) * height };
  const points = [
    { x: combined[4], y: combined[5] },
    { x: combined[4] + widthVector.x, y: combined[5] + widthVector.y },
    { x: combined[4] + heightVector.x, y: combined[5] + heightVector.y },
    { x: combined[4] + widthVector.x + heightVector.x, y: combined[5] + widthVector.y + heightVector.y }
  ];
  const minimumX = Math.min(...points.map((point) => point.x));
  const maximumX = Math.max(...points.map((point) => point.x));
  const minimumY = Math.min(...points.map((point) => point.y));
  const maximumY = Math.max(...points.map((point) => point.y));
  return { x: minimumX, y: minimumY, width: maximumX - minimumX, height: maximumY - minimumY };
}

/**
 * Generation counter for cancellable scans. Starting or cancelling a
 * generation also aborts the previous generation's signal, so in-flight page
 * text extraction can stop early instead of only being discarded.
 */
export class SearchGeneration {
  private generation = 0;
  private controller = new AbortController();

  next(): number {
    this.abort();
    this.generation += 1;
    return this.generation;
  }

  cancel(): void {
    this.abort();
    this.generation += 1;
  }

  isCurrent(value: number): boolean {
    return value === this.generation;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private abort(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replaceAll(/[\u0300-\u036f\u00ad]/g, "").replaceAll(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Fraction of a text line's thickness that separates words within a line. */
const WORD_GAP_FRACTION = 0.2;

/**
 * The separator between two consecutive text items. PDFs often split one word
 * across items (kerning, font changes), so items are only separated by a space
 * when there is evidence of one: explicit whitespace, a visible gap, or a line
 * break. A hyphen at a line end is treated as a line-break hyphenation.
 */
export function textItemSeparator(previous: SearchTextItem, next: SearchTextItem, sawWhitespaceItem = false): { separator: string; dropTrailingHyphen: boolean } {
  if (sawWhitespaceItem || /\s$/u.test(previous.text) || /^\s/u.test(next.text)) return { separator: " ", dropTrailingHyphen: false };
  if (previous.endOfLine) {
    const hyphenated = /[\p{L}\p{N}][-\u2010]$/u.test(previous.text.trimEnd()) && /^\p{Ll}/u.test(next.text.trimStart());
    return hyphenated ? { separator: "", dropTrailingHyphen: true } : { separator: " ", dropTrailingHyphen: false };
  }
  const values = [previous.x, previous.y, previous.width, previous.height, next.x, next.y, next.width, next.height];
  if (!values.every(Number.isFinite)) return { separator: " ", dropTrailingHyphen: false };
  const thickness = Math.max(0, Math.min(previous.width, previous.height, next.width, next.height));
  const gapX = Math.max(0, next.x - (previous.x + previous.width), previous.x - (next.x + next.width));
  const gapY = Math.max(0, next.y - (previous.y + previous.height), previous.y - (next.y + next.height));
  const adjacent = thickness > 0 && Math.max(gapX, gapY) <= thickness * WORD_GAP_FRACTION;
  return { separator: adjacent ? "" : " ", dropTrailingHyphen: false };
}

export function searchContext(text: string, start: number, length: number, radius = 42): string {
  const from = Math.max(0, start - Math.max(0, radius));
  const to = Math.min(text.length, start + length + Math.max(0, radius));
  return `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`;
}

export function matchPageText(page: SearchPageText, query: string): SearchHit[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const pieces: string[] = [];
  const spans: { index: number; start: number; end: number }[] = [];
  let cursor = 0;
  let previousItem: SearchTextItem | undefined;
  let sawWhitespaceItem = false;
  for (let index = 0; index < page.items.length; index += 1) {
    const item = page.items[index];
    const value = normalizeSearchText(item?.text ?? "");
    if (!item || !value) {
      if (item && pieces.length > 0) sawWhitespaceItem = true;
      continue;
    }
    if (previousItem) {
      const { separator, dropTrailingHyphen } = textItemSeparator(previousItem, item, sawWhitespaceItem);
      if (dropTrailingHyphen) {
        const last = spans.at(-1);
        const piece = pieces.at(-1);
        if (last && piece && last.end - last.start > 1) {
          pieces[pieces.length - 1] = piece.slice(0, -1);
          last.end -= 1;
          cursor -= 1;
        }
      }
      if (separator) {
        pieces.push(separator);
        cursor += separator.length;
      }
    }
    const start = cursor;
    pieces.push(value);
    cursor += value.length;
    spans.push({ index, start, end: start + value.length });
    previousItem = item;
    sawWhitespaceItem = false;
  }
  const text = pieces.join("");
  const hits: SearchHit[] = [];
  for (let start = text.indexOf(normalizedQuery); start >= 0; start = text.indexOf(normalizedQuery, start + Math.max(1, normalizedQuery.length))) {
    const end = start + normalizedQuery.length;
    hits.push({
      pageNumber: page.pageNumber,
      context: searchContext(text, start, normalizedQuery.length),
      itemIndexes: spans.filter((span) => span.end > start && span.start < end).map((span) => span.index),
      segments: spans.filter((span) => span.end > start && span.start < end).map((span) => ({
        itemIndex: span.index,
        startOffset: Math.max(0, start - span.start),
        endOffset: Math.min(span.end - span.start, end - span.start)
      }))
    });
  }
  return hits;
}

export async function searchPages(
  pageCount: number,
  query: string,
  loadPage: (pageNumber: number, signal: AbortSignal) => Promise<SearchPageText>,
  generations: SearchGeneration,
  onProgress?: (progress: SearchProgress) => void,
  batchSize = 4,
  maximumRetainedHits = 5000
): Promise<SearchProgress> {
  const generation = generations.next();
  const signal = generations.signal;
  const total = Math.max(0, Math.floor(pageCount));
  const hits: SearchHit[] = [];
  let scanned = 0;
  let textPages = 0;
  let matchCount = 0;
  let failedPages = 0;
  for (let start = 1; start <= total; start += Math.max(1, batchSize)) {
    const numbers = Array.from({ length: Math.min(Math.max(1, batchSize), total - start + 1) }, (_, index) => start + index);
    const pages = await Promise.allSettled(numbers.map((pageNumber) => loadPage(pageNumber, signal)));
    if (!generations.isCurrent(generation)) return { scanned, total, hits: [], matchCount, textPages, failedPages, done: false, cancelled: true };
    for (const result of pages) {
      scanned += 1;
      if (result.status === "rejected") {
        failedPages += 1;
        continue;
      }
      const page = result.value;
      if (page.items.some((item) => normalizeSearchText(item.text).length > 0)) textPages += 1;
      const pageHits = matchPageText(page, query);
      matchCount += pageHits.length;
      const remaining = Math.max(0, maximumRetainedHits - hits.length);
      if (remaining > 0) hits.push(...pageHits.slice(0, remaining));
    }
    onProgress?.({ scanned, total, hits: [...hits], matchCount, textPages, failedPages, done: scanned === total, cancelled: false });
    await Promise.resolve();
  }
  return { scanned, total, hits, matchCount, textPages, failedPages, done: true, cancelled: false };
}

type Matrix = [number, number, number, number, number, number];

function matrix(value: readonly unknown[]): Matrix {
  return [0, 1, 2, 3, 4, 5].map((index) => {
    const entry = value[index];
    return typeof entry === "number" && Number.isFinite(entry) ? entry : index === 0 || index === 3 ? 1 : 0;
  }) as Matrix;
}

function multiply(first: Matrix, second: Matrix): Matrix {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5]
  ];
}

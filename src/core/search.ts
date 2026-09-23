export interface SearchTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
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

export class SearchGeneration {
  private generation = 0;

  next(): number {
    this.generation += 1;
    return this.generation;
  }

  cancel(): void {
    this.generation += 1;
  }

  isCurrent(value: number): boolean {
    return value === this.generation;
  }
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replaceAll(/[\u0300-\u036f]/g, "").replaceAll(/\s+/g, " ").trim().toLocaleLowerCase();
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
  for (let index = 0; index < page.items.length; index += 1) {
    const value = normalizeSearchText(page.items[index]?.text ?? "");
    if (!value) continue;
    if (pieces.length > 0) {
      pieces.push(" ");
      cursor += 1;
    }
    const start = cursor;
    pieces.push(value);
    cursor += value.length;
    spans.push({ index, start, end: start + value.length });
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
  loadPage: (pageNumber: number) => Promise<SearchPageText>,
  generations: SearchGeneration,
  onProgress?: (progress: SearchProgress) => void,
  batchSize = 4,
  maximumRetainedHits = 5000
): Promise<SearchProgress> {
  const generation = generations.next();
  const total = Math.max(0, Math.floor(pageCount));
  const hits: SearchHit[] = [];
  let scanned = 0;
  let textPages = 0;
  let matchCount = 0;
  for (let start = 1; start <= total; start += Math.max(1, batchSize)) {
    const numbers = Array.from({ length: Math.min(Math.max(1, batchSize), total - start + 1) }, (_, index) => start + index);
    const pages = await Promise.all(numbers.map(loadPage));
    if (!generations.isCurrent(generation)) return { scanned, total, hits: [], matchCount, textPages, done: false, cancelled: true };
    for (const page of pages) {
      if (page.items.some((item) => normalizeSearchText(item.text).length > 0)) textPages += 1;
      const pageHits = matchPageText(page, query);
      matchCount += pageHits.length;
      const remaining = Math.max(0, maximumRetainedHits - hits.length);
      if (remaining > 0) hits.push(...pageHits.slice(0, remaining));
      scanned += 1;
    }
    onProgress?.({ scanned, total, hits: [...hits], matchCount, textPages, done: scanned === total, cancelled: false });
    await Promise.resolve();
  }
  return { scanned, total, hits, matchCount, textPages, done: true, cancelled: false };
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

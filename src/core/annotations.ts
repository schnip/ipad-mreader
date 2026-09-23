import type { SearchPageText, SearchTextItem } from "./search";

export type Annotation = HighlightAnnotation | NoteAnnotation | InkAnnotation;
export type AnnotationKind = Annotation["kind"];

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface NormalizedRect extends NormalizedPoint {
  width: number;
  height: number;
}

export interface AnnotationBase {
  id: string;
  documentId: string;
  pageNumber: number;
  createdAt: number;
  updatedAt: number;
}

export interface HighlightAnnotation extends AnnotationBase {
  kind: "highlight";
  color: string;
  rects: NormalizedRect[];
  text: string;
  context: string;
}

export interface NoteAnnotation extends AnnotationBase {
  kind: "note";
  color: string;
  rects: NormalizedRect[];
  text: string;
  context: string;
  body: string;
}

export interface InkPoint extends NormalizedPoint {
  pressure: number;
  elapsed: number;
}

export interface InkAnnotation extends AnnotationBase {
  kind: "ink";
  color: string;
  baseWidth: number;
  points: InkPoint[];
}

export interface TextPosition {
  itemIndex: number;
  offset: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface SelectionGeometry {
  range: TextRange;
  rects: NormalizedRect[];
  startHandle: NormalizedPoint;
  endHandle: NormalizedPoint;
  text: string;
  context: string;
}

export interface InkSegment {
  from: InkPoint;
  to: InkPoint;
  width: number;
}

export const MAX_ANNOTATION_RECTS = 512;
export const MAX_INK_POINTS = 2048;
export const DEFAULT_HIGHLIGHT_COLOR = "#ffe45c";
export const DEFAULT_NOTE_COLOR = "#ffb347";
export const DEFAULT_INK_COLOR = "#d92d3f";

export function createAnnotationId(timestamp = Date.now(), random = Math.random()): string {
  const safeTime = Math.max(0, Math.floor(finite(timestamp, 0))).toString(36);
  const safeRandom = Math.floor(clamp(finite(random, 0), 0, 0.999999999999) * 0x100000000).toString(36).padStart(7, "0");
  return `ann-${safeTime}-${safeRandom}`;
}

export function annotationMetadata(documentId: string, pageNumber: number, timestamp = Date.now(), id = createAnnotationId(timestamp)): AnnotationBase {
  return {
    id,
    documentId: documentId.trim(),
    pageNumber: Math.max(1, Math.round(finite(pageNumber, 1))),
    createdAt: Math.max(0, finite(timestamp, 0)),
    updatedAt: Math.max(0, finite(timestamp, 0))
  };
}

export function normalizeAnnotation(value: unknown): Annotation | undefined {
  if (!isRecord(value)) return undefined;
  const base = normalizeBase(value);
  if (!base) return undefined;
  if (value.kind === "highlight") {
    const rects = normalizeRects(value.rects);
    if (rects.length === 0) return undefined;
    return {
      ...base,
      kind: "highlight",
      color: normalizeColor(value.color, DEFAULT_HIGHLIGHT_COLOR),
      rects,
      text: boundedText(value.text, 20_000),
      context: boundedText(value.context, 20_000)
    };
  }
  if (value.kind === "note") {
    const rects = normalizeRects(value.rects);
    if (rects.length === 0) return undefined;
    return {
      ...base,
      kind: "note",
      color: normalizeColor(value.color, DEFAULT_NOTE_COLOR),
      rects,
      text: boundedText(value.text, 20_000),
      context: boundedText(value.context, 20_000),
      body: boundedText(value.body, 50_000)
    };
  }
  if (value.kind === "ink") {
    const source = Array.isArray(value.points) ? value.points.slice(0, MAX_INK_POINTS) : [];
    const points = source.map(normalizeInkPoint).filter((point): point is InkPoint => point !== undefined);
    if (points.length < 2) return undefined;
    return {
      ...base,
      kind: "ink",
      color: normalizeColor(value.color, DEFAULT_INK_COLOR),
      baseWidth: clamp(finite(value.baseWidth, 2.2), 0.5, 12),
      points
    };
  }
  return undefined;
}

export function orderAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return annotations.map((annotation, index) => ({ annotation, index })).sort((a, b) => (
    a.annotation.pageNumber - b.annotation.pageNumber
      || a.annotation.createdAt - b.annotation.createdAt
      || a.annotation.id.localeCompare(b.annotation.id)
      || a.index - b.index
  )).map(({ annotation }) => annotation);
}

export function annotationsForPage(annotations: readonly Annotation[], pageNumber: number): Annotation[] {
  return orderAnnotations(annotations.filter((annotation) => annotation.pageNumber === pageNumber));
}

export function characterHitTest(page: SearchPageText, point: NormalizedPoint, maximumDistance = 0.035): TextPosition | undefined {
  if (page.width <= 0 || page.height <= 0 || page.items.length === 0) return undefined;
  const target = { x: clamp(point.x, 0, 1) * page.width, y: clamp(point.y, 0, 1) * page.height };
  let best: { position: TextPosition; distance: number } | undefined;
  page.items.forEach((item, itemIndex) => {
    if (!item.text || item.width <= 0 || item.height <= 0) return;
    const distance = distanceToRect(target, item);
    const normalizedDistance = Math.hypot(distance.x / page.width, distance.y / page.height);
    if (normalizedDistance > Math.max(0, maximumDistance) || normalizedDistance >= (best?.distance ?? Number.POSITIVE_INFINITY)) return;
    const fraction = clamp((target.x - item.x) / item.width, 0, 0.999999);
    best = { position: { itemIndex, offset: Math.min(item.text.length - 1, Math.floor(fraction * item.text.length)) }, distance: normalizedDistance };
  });
  return best?.position;
}

export function normalizeTextRange(page: SearchPageText, first: TextPosition, second: TextPosition): TextRange | undefined {
  const a = normalizeTextPosition(page, first);
  const b = normalizeTextPosition(page, second);
  if (!a || !b) return undefined;
  return compareTextPositions(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a };
}

export function selectionRangeGeometry(page: SearchPageText, first: TextPosition, second: TextPosition, contextRadius = 48): SelectionGeometry | undefined {
  const range = normalizeTextRange(page, first, second);
  if (!range || compareTextPositions(range.start, range.end) === 0 || page.width <= 0 || page.height <= 0) return undefined;
  const rects: NormalizedRect[] = [];
  const selected: string[] = [];
  const allText: string[] = [];
  let selectionStart = 0;
  let selectionEnd = 0;
  let cursor = 0;
  page.items.forEach((item, itemIndex) => {
    if (allText.length > 0) {
      allText.push(" ");
      cursor += 1;
    }
    const itemStart = cursor;
    allText.push(item.text);
    cursor += item.text.length;
    const from = itemIndex === range.start.itemIndex ? range.start.offset : itemIndex > range.start.itemIndex ? 0 : item.text.length;
    const to = itemIndex === range.end.itemIndex ? range.end.offset : itemIndex < range.end.itemIndex ? item.text.length : 0;
    if (itemIndex < range.start.itemIndex || itemIndex > range.end.itemIndex || to <= from || item.text.length === 0) return;
    if (selected.length === 0) selectionStart = itemStart + from;
    selectionEnd = itemStart + to;
    selected.push(item.text.slice(from, to));
    const startFraction = from / item.text.length;
    const endFraction = to / item.text.length;
    const rect = normalizeRect({
      x: (item.x + item.width * startFraction) / page.width,
      y: item.y / page.height,
      width: item.width * (endFraction - startFraction) / page.width,
      height: item.height / page.height
    });
    if (rect) rects.push(rect);
  });
  const validRects = rects.slice(0, MAX_ANNOTATION_RECTS);
  const firstRect = validRects[0];
  const lastRect = validRects.at(-1);
  if (!firstRect || !lastRect) return undefined;
  const complete = allText.join("");
  const radius = Math.max(0, Math.floor(contextRadius));
  const contextFrom = Math.max(0, selectionStart - radius);
  const contextTo = Math.min(complete.length, selectionEnd + radius);
  return {
    range,
    rects: validRects,
    startHandle: { x: firstRect.x, y: firstRect.y + firstRect.height },
    endHandle: { x: lastRect.x + lastRect.width, y: lastRect.y + lastRect.height },
    text: selected.join(" "),
    context: `${contextFrom > 0 ? "…" : ""}${complete.slice(contextFrom, contextTo).trim()}${contextTo < complete.length ? "…" : ""}`
  };
}

export function clampPressure(pressure: number): number {
  return clamp(finite(pressure, 0.5), 0.05, 1);
}

export function pressureStrokeWidth(pressure: number, baseWidth = 2.2): number {
  return clamp(finite(baseWidth, 2.2), 0.5, 12) * (0.45 + clampPressure(pressure) * 0.9);
}

export function appendInkPoint(points: readonly InkPoint[], value: Partial<InkPoint>, minimumDistance = 0.0008, maximumPoints = MAX_INK_POINTS): InkPoint[] {
  const point = normalizeInkPoint(value);
  if (!point) return [...points];
  const cap = Math.max(2, Math.min(MAX_INK_POINTS, Math.floor(maximumPoints)));
  const result = points.slice(0, cap);
  const previous = result.at(-1);
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < Math.max(0, minimumDistance)) {
    result[result.length - 1] = point;
    return result;
  }
  if (result.length < cap) {
    result.push(point);
    return result;
  }
  const reduced = result.filter((_, index) => index === 0 || index === result.length - 1 || index % 2 === 0);
  reduced[reduced.length - 1] = point;
  return reduced.slice(0, cap);
}

export function inkSegments(points: readonly InkPoint[], baseWidth = 2.2): InkSegment[] {
  const segments: InkSegment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (!from || !to || from.x === to.x && from.y === to.y) continue;
    segments.push({ from, to, width: pressureStrokeWidth((from.pressure + to.pressure) / 2, baseWidth) });
  }
  return segments;
}

export function normalizedPointInRect(point: NormalizedPoint, rect: NormalizedRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function normalizeBase(value: Record<string, unknown>): AnnotationBase | undefined {
  if (typeof value.id !== "string" || !value.id.trim() || typeof value.documentId !== "string" || !value.documentId.trim()) return undefined;
  const pageNumber = Math.round(finite(value.pageNumber, 0));
  if (pageNumber < 1) return undefined;
  const createdAt = Math.max(0, finite(value.createdAt, 0));
  return {
    id: value.id.trim().slice(0, 200),
    documentId: value.documentId.trim().slice(0, 500),
    pageNumber,
    createdAt,
    updatedAt: Math.max(createdAt, finite(value.updatedAt, createdAt))
  };
}

function normalizeRects(value: unknown): NormalizedRect[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ANNOTATION_RECTS).map((entry) => isRecord(entry) ? normalizeRect(entry) : undefined)
    .filter((rect): rect is NormalizedRect => rect !== undefined);
}

function normalizeRect(value: Partial<NormalizedRect>): NormalizedRect | undefined {
  const left = clamp(finite(value.x, 0), 0, 1);
  const top = clamp(finite(value.y, 0), 0, 1);
  const right = clamp(left + Math.max(0, finite(value.width, 0)), left, 1);
  const bottom = clamp(top + Math.max(0, finite(value.height, 0)), top, 1);
  if (right - left <= 0 || bottom - top <= 0) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizeInkPoint(value: unknown): InkPoint | undefined {
  if (!isRecord(value)) return undefined;
  const x = finite(value.x, Number.NaN);
  const y = finite(value.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return {
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    pressure: clampPressure(finite(value.pressure, 0.5)),
    elapsed: Math.max(0, finite(value.elapsed, 0))
  };
}

function normalizeTextPosition(page: SearchPageText, value: TextPosition): TextPosition | undefined {
  const itemIndex = Math.round(finite(value.itemIndex, -1));
  const item = page.items[itemIndex];
  if (!item) return undefined;
  return { itemIndex, offset: Math.round(clamp(finite(value.offset, 0), 0, item.text.length)) };
}

function compareTextPositions(a: TextPosition, b: TextPosition): number {
  return a.itemIndex - b.itemIndex || a.offset - b.offset;
}

function distanceToRect(point: NormalizedPoint, rect: SearchTextItem): NormalizedPoint {
  return {
    x: point.x < rect.x ? rect.x - point.x : point.x > rect.x + rect.width ? point.x - rect.x - rect.width : 0,
    y: point.y < rect.y ? rect.y - point.y : point.y > rect.y + rect.height ? point.y - rect.y - rect.height : 0
  };
}

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

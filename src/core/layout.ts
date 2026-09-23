export interface Size {
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export type ReaderLayout = "single" | "twoUp" | "twoUpCover" | "continuous";

export interface NumberedPageLayout extends PageLayout {
  pageNumber: number;
}

export interface SpreadLayout {
  pages: NumberedPageLayout[];
  width: number;
  height: number;
}

export interface SpreadSlot {
  slot: -1 | 0 | 1;
  anchorPage: number;
  pages: number[];
}

export interface ContinuousMomentum {
  scroll: number;
  velocity: number;
  reachedBound: boolean;
  settled: boolean;
}

export interface ContinuousLayout {
  pages: NumberedPageLayout[];
  width: number;
  height: number;
  gap: number;
}

export const DEFAULT_PAGE_INSET = 16;

export function layoutSinglePage(
  page: Size,
  viewport: Size,
  insets: Partial<Insets> = {},
  pageInset = DEFAULT_PAGE_INSET
): PageLayout {
  const safe = {
    top: Math.max(0, insets.top ?? 0),
    right: Math.max(0, insets.right ?? 0),
    bottom: Math.max(0, insets.bottom ?? 0),
    left: Math.max(0, insets.left ?? 0)
  };
  const pageWidth = positive(page.width);
  const pageHeight = positive(page.height);
  const availableWidth = Math.max(1, viewport.width - safe.left - safe.right - pageInset * 2);
  const availableHeight = Math.max(1, viewport.height - safe.top - safe.bottom - pageInset * 2);
  const scale = Math.min(availableWidth / pageWidth, availableHeight / pageHeight);
  const width = pageWidth * scale;
  const height = pageHeight * scale;
  return {
    x: safe.left + pageInset + (availableWidth - width) / 2,
    y: safe.top + pageInset + (availableHeight - height) / 2,
    width,
    height,
    scale
  };
}

export function pageWidthZoom(layout: PageLayout, viewport: Size, insets: Partial<Insets> = {}, pageInset = DEFAULT_PAGE_INSET): number {
  const available = Math.max(1, viewport.width - (insets.left ?? 0) - (insets.right ?? 0) - pageInset * 2);
  return Math.max(1, available / Math.max(layout.width, 1));
}

export function normalizeReaderLayout(value: unknown): ReaderLayout {
  return value === "twoUp" || value === "twoUpCover" || value === "continuous" ? value : "single";
}

export function hasMeaningfulZoomDelta(currentScale: number, requestedScale: number, minimumFraction = 0.1): boolean {
  if (!Number.isFinite(currentScale) || !Number.isFinite(requestedScale) || currentScale <= 0 || requestedScale <= 0) return false;
  return Math.abs(requestedScale - currentScale) / currentScale >= Math.max(0, minimumFraction);
}

export function spreadPageNumbers(pageNumber: number, pageCount: number, layout: "twoUp" | "twoUpCover"): number[] {
  const count = Math.max(1, Math.floor(pageCount));
  const page = Math.min(count, Math.max(1, Math.floor(pageNumber)));
  if (layout === "twoUpCover") {
    if (page === 1) return [1];
    const first = page % 2 === 0 ? page : page - 1;
    return [first, first + 1].filter((value) => value <= count);
  }
  const first = page % 2 === 1 ? page : page - 1;
  return [first, first + 1].filter((value) => value <= count);
}

export function nextSpreadPage(pageNumber: number, pageCount: number, layout: "twoUp" | "twoUpCover", direction: -1 | 1): number {
  const spread = spreadPageNumbers(pageNumber, pageCount, layout);
  const target = direction > 0 ? (spread.at(-1) ?? pageNumber) + 1 : (spread[0] ?? pageNumber) - 1;
  return spreadPageNumbers(Math.min(pageCount, Math.max(1, target)), pageCount, layout)[0] ?? 1;
}

export function adjacentSpreadSlots(pageNumber: number, pageCount: number, layout: "twoUp" | "twoUpCover"): SpreadSlot[] {
  const currentPages = spreadPageNumbers(pageNumber, pageCount, layout);
  const current = currentPages[0] ?? 1;
  const previous = nextSpreadPage(current, pageCount, layout, -1);
  const next = nextSpreadPage(current, pageCount, layout, 1);
  const slots: SpreadSlot[] = [];
  if (previous !== current) slots.push({ slot: -1, anchorPage: previous, pages: spreadPageNumbers(previous, pageCount, layout) });
  slots.push({ slot: 0, anchorPage: current, pages: currentPages });
  if (next !== current) slots.push({ slot: 1, anchorPage: next, pages: spreadPageNumbers(next, pageCount, layout) });
  return slots;
}

export function unionPageLayouts(layouts: readonly PageLayout[]): PageLayout | undefined {
  const first = layouts[0];
  if (!first) return undefined;
  const left = Math.min(...layouts.map((layout) => layout.x));
  const top = Math.min(...layouts.map((layout) => layout.y));
  const right = Math.max(...layouts.map((layout) => layout.x + layout.width));
  const bottom = Math.max(...layouts.map((layout) => layout.y + layout.height));
  return { x: left, y: top, width: right - left, height: bottom - top, scale: first.scale };
}

export function layoutSpread(
  pages: readonly { pageNumber: number; size: Size }[],
  viewport: Size,
  insets: Partial<Insets> = {},
  pageInset = DEFAULT_PAGE_INSET,
  gap = 12
): SpreadLayout {
  const safe = safeInsets(insets);
  const boundedGap = pages.length > 1 ? Math.max(0, gap) : 0;
  const availableWidth = Math.max(1, viewport.width - safe.left - safe.right - pageInset * 2);
  const availableHeight = Math.max(1, viewport.height - safe.top - safe.bottom - pageInset * 2);
  const sourceWidth = pages.reduce((total, page) => total + positive(page.size.width), 0);
  const sourceHeight = pages.reduce((maximum, page) => Math.max(maximum, positive(page.size.height)), 1);
  const scale = Math.min((availableWidth - boundedGap) / Math.max(1, sourceWidth), availableHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale + boundedGap;
  let x = safe.left + pageInset + (availableWidth - renderedWidth) / 2;
  const layouts = pages.map((page) => {
    const width = positive(page.size.width) * scale;
    const height = positive(page.size.height) * scale;
    const result = {
      pageNumber: page.pageNumber,
      x,
      y: safe.top + pageInset + (availableHeight - height) / 2,
      width,
      height,
      scale
    };
    x += width + boundedGap;
    return result;
  });
  return { pages: layouts, width: viewport.width, height: viewport.height };
}

export function layoutContinuous(
  pageSizes: readonly Size[],
  viewport: Size,
  insets: Partial<Insets> = {},
  pageInset = DEFAULT_PAGE_INSET,
  gap = 18
): ContinuousLayout {
  const safe = safeInsets(insets);
  const boundedGap = Math.max(0, gap);
  const availableWidth = Math.max(1, viewport.width - safe.left - safe.right - pageInset * 2);
  let y = safe.top + pageInset;
  const pages = pageSizes.map((size, index) => {
    const pageWidth = positive(size.width);
    const pageHeight = positive(size.height);
    const scale = availableWidth / pageWidth;
    const height = pageHeight * scale;
    const page = { pageNumber: index + 1, x: safe.left + pageInset, y, width: availableWidth, height, scale };
    y += height + boundedGap;
    return page;
  });
  const height = Math.max(viewport.height, y - (pages.length > 0 ? boundedGap : 0) + safe.bottom + pageInset);
  return { pages, width: viewport.width, height, gap: boundedGap };
}

export function continuousScrollBounds(layout: ContinuousLayout, viewport: Size): { minimum: number; maximum: number } {
  return { minimum: 0, maximum: Math.max(0, layout.height - Math.max(1, viewport.height)) };
}

export function constrainContinuousScroll(scroll: number, bounds: { minimum: number; maximum: number }): number {
  const minimum = Math.min(bounds.minimum, bounds.maximum);
  const maximum = Math.max(bounds.minimum, bounds.maximum);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(scroll) ? scroll : minimum));
}

export function trackContinuousVelocity(
  previousVelocity: number,
  scrollDelta: number,
  elapsedMilliseconds: number,
  sampleWeight = 0.35
): number {
  const elapsed = Math.max(1, Number.isFinite(elapsedMilliseconds) ? elapsedMilliseconds : 1);
  const sample = (Number.isFinite(scrollDelta) ? scrollDelta : 0) / elapsed;
  const weight = Math.min(1, Math.max(0, sampleWeight));
  return (Number.isFinite(previousVelocity) ? previousVelocity : 0) * (1 - weight) + sample * weight;
}

export function stepContinuousMomentum(
  scroll: number,
  velocity: number,
  elapsedMilliseconds: number,
  bounds: { minimum: number; maximum: number },
  decayMilliseconds = 360
): ContinuousMomentum {
  const elapsed = Math.min(50, Math.max(0, Number.isFinite(elapsedMilliseconds) ? elapsedMilliseconds : 0));
  const currentVelocity = Number.isFinite(velocity) ? velocity : 0;
  const nextVelocity = currentVelocity * Math.exp(-elapsed / Math.max(1, decayMilliseconds));
  const requested = scroll + (currentVelocity + nextVelocity) * elapsed / 2;
  const nextScroll = constrainContinuousScroll(requested, bounds);
  const reachedBound = Math.abs(nextScroll - requested) > 0.01;
  const boundedVelocity = reachedBound ? 0 : nextVelocity;
  return {
    scroll: nextScroll,
    velocity: boundedVelocity,
    reachedBound,
    settled: reachedBound || Math.abs(boundedVelocity) < 0.02
  };
}

export function shouldRefreshContinuousWindow(
  scroll: number,
  renderedScroll: number,
  viewportHeight: number,
  refreshFraction = 0.5
): boolean {
  if (!Number.isFinite(renderedScroll)) return true;
  const threshold = Math.max(1, Math.max(0, refreshFraction) * Math.max(1, viewportHeight));
  return Math.abs(scroll - renderedScroll) >= threshold;
}

export function visibleContinuousPages(
  layout: ContinuousLayout,
  scrollY: number,
  viewport: Size,
  overscanScreens = 1
): NumberedPageLayout[] {
  const overscan = Math.max(0, overscanScreens) * Math.max(1, viewport.height);
  const minimum = scrollY - overscan;
  const maximum = scrollY + viewport.height + overscan;
  return layout.pages.filter((page) => page.y + page.height >= minimum && page.y <= maximum);
}

export function continuousPageAtViewportCenter(layout: ContinuousLayout, scrollY: number, viewport: Size): number {
  const center = scrollY + viewport.height / 2;
  let closest = layout.pages[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const page of layout.pages) {
    const nextDistance = Math.abs(page.y + page.height / 2 - center);
    if (nextDistance < distance) {
      closest = page;
      distance = nextDistance;
    }
  }
  return closest?.pageNumber ?? 1;
}

export function continuousScrollForPage(layout: ContinuousLayout, pageNumber: number, viewport: Size): number {
  const page = layout.pages[Math.max(0, Math.floor(pageNumber) - 1)];
  if (!page) return 0;
  const requested = page.y + page.height / 2 - viewport.height / 2;
  const bounds = continuousScrollBounds(layout, viewport);
  return Math.min(bounds.maximum, Math.max(bounds.minimum, requested));
}

export function sameLayout(a: PageLayout, b: PageLayout, tolerance = 0.01): boolean {
  return Math.abs(a.x - b.x) <= tolerance
    && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance
    && Math.abs(a.height - b.height) <= tolerance
    && Math.abs(a.scale - b.scale) <= tolerance;
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function safeInsets(insets: Partial<Insets>): Insets {
  return {
    top: Math.max(0, insets.top ?? 0),
    right: Math.max(0, insets.right ?? 0),
    bottom: Math.max(0, insets.bottom ?? 0),
    left: Math.max(0, insets.left ?? 0)
  };
}

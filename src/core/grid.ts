import { clamp } from "./scene";
import type { Insets, Size } from "./layout";
import type { Point } from "./scene";

export interface GridPageLayout {
  pageNumber: number;
  row: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridLayout {
  pages: GridPageLayout[];
  width: number;
  height: number;
  columns: number;
  rows: number;
  gap: number;
}

export interface GridOptions {
  targetRowHeight?: number;
  minimumRows?: number;
  maximumRows?: number;
  gap?: number;
  margin?: number;
  maximumAspectRatio?: number;
}

export interface GridBounds {
  minimum: number;
  maximum: number;
}

export interface GridDragState {
  legalOffset: number;
  overscroll: number;
  visualOffset: number;
}

export interface GridSpringState {
  displacement: number;
  velocity: number;
  settled: boolean;
}

export function layoutGrid(
  pageSizes: readonly Size[],
  viewport: Size,
  insets: Partial<Insets> = {},
  options: GridOptions = {}
): GridLayout {
  const gap = Math.max(0, options.gap ?? 18);
  const margin = Math.max(0, options.margin ?? 20);
  const safeLeft = Math.max(0, insets.left ?? 0);
  const safeRight = Math.max(0, insets.right ?? 0);
  const safeTop = Math.max(0, insets.top ?? 0);
  const safeBottom = Math.max(0, insets.bottom ?? 0);
  const availableHeight = Math.max(1, viewport.height - safeTop - safeBottom - margin * 2);
  const minimumRows = Math.max(1, Math.round(options.minimumRows ?? 2));
  const maximumRows = Math.max(minimumRows, Math.round(options.maximumRows ?? 4));
  const targetRowHeight = Math.max(1, options.targetRowHeight ?? 210);
  const rows = Math.round(clamp(
    Math.floor((availableHeight + gap) / (targetRowHeight + gap)),
    minimumRows,
    maximumRows
  ));
  const rowHeight = Math.max(1, (availableHeight - gap * (rows - 1)) / rows);
  const maximumAspectRatio = Math.max(1, options.maximumAspectRatio ?? 1.65);
  const pages: GridPageLayout[] = [];
  let x = safeLeft + margin;

  for (let columnStart = 0, column = 0; columnStart < pageSizes.length; columnStart += rows, column += 1) {
    const columnSizes = pageSizes.slice(columnStart, columnStart + rows);
    const dimensions = columnSizes.map((size) => thumbnailSize(size, rowHeight * maximumAspectRatio, rowHeight));
    const columnWidth = dimensions.reduce((maximum, size) => Math.max(maximum, size.width), 1);
    for (let row = 0; row < dimensions.length; row += 1) {
      const size = dimensions[row];
      if (!size) continue;
      const cellY = safeTop + margin + row * (rowHeight + gap);
      pages.push({
        pageNumber: columnStart + row + 1,
        row,
        column,
        x: x + (columnWidth - size.width) / 2,
        y: cellY + (rowHeight - size.height) / 2,
        width: size.width,
        height: size.height
      });
    }
    x += columnWidth + gap;
  }

  return {
    pages,
    width: Math.max(safeLeft + safeRight + margin * 2, x - gap + safeRight + margin),
    height: viewport.height,
    columns: Math.ceil(pageSizes.length / rows),
    rows,
    gap
  };
}

export function constrainGridOffset(
  requestedOffset: number,
  layout: GridLayout,
  viewport: Size,
  insets: Partial<Insets> = {},
  margin = 12
): number {
  const bounds = gridOffsetBounds(layout, viewport, insets, margin);
  return clamp(requestedOffset, bounds.minimum, bounds.maximum);
}

export function gridOffsetBounds(
  layout: GridLayout,
  viewport: Size,
  insets: Partial<Insets> = {},
  margin = 12
): GridBounds {
  const left = Math.max(0, insets.left ?? 0) + Math.max(0, margin);
  const right = viewport.width - Math.max(0, insets.right ?? 0) - Math.max(0, margin);
  const available = Math.max(1, right - left);
  if (layout.width <= available) {
    const centered = left + (available - layout.width) / 2;
    return { minimum: centered, maximum: centered };
  }
  return { minimum: right - layout.width, maximum: left };
}

export function rubberBandDisplacement(distance: number, maximum = 36, resistance = 0.55): number {
  if (!Number.isFinite(distance) || distance === 0) return 0;
  const limit = Math.max(0, maximum);
  if (limit === 0) return 0;
  const magnitude = limit * (1 - Math.exp(-Math.abs(distance) * Math.max(0, resistance) / limit));
  return Math.sign(distance) * Math.min(limit, magnitude);
}

export function dragGridOffset(
  legalOffset: number,
  overscroll: number,
  delta: number,
  bounds: GridBounds,
  maximumDisplacement = 36
): GridDragState {
  let nextLegal = clamp(legalOffset, bounds.minimum, bounds.maximum);
  let nextOverscroll = Number.isFinite(overscroll) ? overscroll : 0;
  const movement = Number.isFinite(delta) ? delta : 0;
  if (nextOverscroll !== 0) {
    const candidate = nextOverscroll + movement;
    if (candidate === 0 || Math.sign(candidate) !== Math.sign(nextOverscroll)) {
      nextOverscroll = 0;
      nextLegal = clamp(nextLegal + candidate, bounds.minimum, bounds.maximum);
    } else {
      nextOverscroll = candidate;
    }
  } else {
    const requested = nextLegal + movement;
    nextLegal = clamp(requested, bounds.minimum, bounds.maximum);
    nextOverscroll = requested - nextLegal;
  }
  return {
    legalOffset: nextLegal,
    overscroll: nextOverscroll,
    visualOffset: nextLegal + rubberBandDisplacement(nextOverscroll, maximumDisplacement)
  };
}

export function stepGridSpring(
  displacement: number,
  velocity: number,
  elapsedMilliseconds: number,
  maximumDisplacement = 36,
  stiffness = 0.0009,
  damping = 0.018
): GridSpringState {
  const elapsed = clamp(elapsedMilliseconds, 0, 50);
  const boundedDisplacement = clamp(displacement, -Math.max(0, maximumDisplacement), Math.max(0, maximumDisplacement));
  const nextVelocity = (velocity - boundedDisplacement * Math.max(0, stiffness) * elapsed) * Math.exp(-Math.max(0, damping) * elapsed);
  const nextDisplacement = clamp(
    boundedDisplacement + nextVelocity * elapsed,
    -Math.max(0, maximumDisplacement),
    Math.max(0, maximumDisplacement)
  );
  const settled = Math.abs(nextDisplacement) < 0.08 && Math.abs(nextVelocity) < 0.008;
  return settled
    ? { displacement: 0, velocity: 0, settled: true }
    : { displacement: nextDisplacement, velocity: nextVelocity, settled: false };
}

export function gridOffsetForPage(
  layout: GridLayout,
  pageNumber: number,
  viewport: Size,
  insets: Partial<Insets> = {}
): number {
  const page = layout.pages[pageNumber - 1];
  if (!page) return constrainGridOffset(0, layout, viewport, insets);
  const safeCenter = ((insets.left ?? 0) + viewport.width - (insets.right ?? 0)) / 2;
  return constrainGridOffset(safeCenter - (page.x + page.width / 2), layout, viewport, insets);
}

export function visibleGridPages(
  layout: GridLayout,
  offsetY: number,
  viewport: Size,
  overscanScreens = 1
): GridPageLayout[] {
  const overscan = Math.max(0, overscanScreens) * viewport.width;
  const minimumX = -overscan;
  const maximumX = viewport.width + overscan;
  return layout.pages.filter((page) => page.x + offsetY + page.width >= minimumX && page.x + offsetY <= maximumX);
}

export function shouldRefreshGridWindow(
  offsetY: number,
  lastRenderedOffsetY: number,
  viewportHeight: number,
  refreshFraction = 0.5
): boolean {
  if (!Number.isFinite(lastRenderedOffsetY)) return true;
  const threshold = Math.max(1, Math.max(0, refreshFraction) * Math.max(1, viewportHeight));
  return Math.abs(offsetY - lastRenderedOffsetY) >= threshold;
}

export function gridPageAtPoint(layout: GridLayout, offsetY: number, point: Point): number | undefined {
  const sceneX = point.x - offsetY;
  const hit = layout.pages.find((page) => (
    sceneX >= page.x
    && sceneX <= page.x + page.width
    && point.y >= page.y
    && point.y <= page.y + page.height
  ));
  return hit?.pageNumber;
}

export function nearestGridPage(layout: GridLayout, offsetY: number, point: Point): number {
  let nearest = layout.pages[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const page of layout.pages) {
    const distance = Math.hypot(point.x - (page.x + offsetY + page.width / 2), point.y - (page.y + page.height / 2));
    if (distance < nearestDistance) {
      nearest = page;
      nearestDistance = distance;
    }
  }
  return nearest?.pageNumber ?? 1;
}

export interface GridMomentum {
  offset: number;
  velocity: number;
}

export function stepGridMomentum(
  offset: number,
  velocity: number,
  elapsedMilliseconds: number,
  decayMilliseconds = 360
): GridMomentum {
  const elapsed = clamp(elapsedMilliseconds, 0, 50);
  const decay = Math.exp(-elapsed / Math.max(1, decayMilliseconds));
  const nextVelocity = velocity * decay;
  return {
    offset: offset + ((velocity + nextVelocity) / 2) * elapsed,
    velocity: nextVelocity
  };
}

function thumbnailSize(page: Size, maximumWidth: number, maximumHeight: number): Size {
  const width = positive(page.width);
  const height = positive(page.height);
  const scale = Math.min(maximumWidth / width, maximumHeight / height);
  return { width: width * scale, height: height * scale };
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

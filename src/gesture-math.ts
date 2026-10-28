export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface RectSize {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SwipeDecisionInput {
  deltaX: number;
  deltaY: number;
  elapsedMs: number;
  viewportWidth: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function pointInLocalSpace(client: Point, bounds: RectSize, localWidth: number, localHeight: number): Point {
  return {
    x: (client.x - bounds.left) * (localWidth / Math.max(bounds.width, 1)),
    y: (client.y - bounds.top) * (localHeight / Math.max(bounds.height, 1))
  };
}

export function characterIndexAt(clientX: number, left: number, width: number, length: number): number | undefined {
  if (length <= 0) return undefined;
  const fraction = clamp((clientX - left) / Math.max(width, 1), 0, 0.999999);
  return Math.floor(fraction * length);
}

export function zoomAroundPoint(
  initial: Camera,
  ratio: number,
  initialCenter: Point,
  currentCenter: Point
): Camera {
  const scale = clamp(initial.scale * ratio, MIN_SCALE, MAX_SCALE);
  const appliedRatio = scale / initial.scale;
  return {
    scale,
    x: currentCenter.x - (initialCenter.x - initial.x) * appliedRatio,
    y: currentCenter.y - (initialCenter.y - initial.y) * appliedRatio
  };
}

export function decideSwipe(input: SwipeDecisionInput): -1 | 0 | 1 {
  if (Math.abs(input.deltaX) <= Math.abs(input.deltaY) * 1.15) return 0;
  const distanceThreshold = Math.min(140, input.viewportWidth * 0.2);
  const velocity = input.deltaX / Math.max(input.elapsedMs, 1);
  if (Math.abs(input.deltaX) < distanceThreshold && Math.abs(velocity) < 0.45) return 0;
  return input.deltaX < 0 ? 1 : -1;
}

import { MAX_CAMERA_SCALE, MIN_CAMERA_SCALE, clamp } from "./scene";
import type { Camera, Point } from "./scene";

export type GestureIntent = "undecided" | "page-turn" | "pan";

export interface SwipeInput {
  deltaX: number;
  deltaY: number;
  elapsedMs: number;
  viewportWidth: number;
}

export interface TapSample {
  at: number;
  point: Point;
}

export interface PageSettleMotion {
  durationMilliseconds: number;
  initialControlY: number;
}

export interface PageTurnRelease {
  direction: -1 | 0 | 1;
  releaseVelocity: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function gestureIntent(delta: Point, cameraScale: number, activationDistance = 8): GestureIntent {
  if (Math.hypot(delta.x, delta.y) < activationDistance) return "undecided";
  if (cameraScale > MIN_CAMERA_SCALE + 0.01) return "pan";
  return Math.abs(delta.x) > Math.abs(delta.y) * 1.15 ? "page-turn" : "undecided";
}

export function decidePageTurn(input: SwipeInput): -1 | 0 | 1 {
  if (Math.abs(input.deltaX) <= Math.abs(input.deltaY) * 1.15) return 0;
  const distanceThreshold = Math.min(140, Math.max(1, input.viewportWidth) * 0.2);
  const velocity = input.deltaX / Math.max(input.elapsedMs, 1);
  if (Math.abs(input.deltaX) < distanceThreshold && Math.abs(velocity) < 0.45) return 0;
  return input.deltaX < 0 ? 1 : -1;
}

export function pageTurnDragOffset(deltaX: number, hasPageInDirection: boolean): number {
  return hasPageInDirection ? deltaX : Math.sign(deltaX) * Math.sqrt(Math.abs(deltaX)) * 5;
}

export function pageReleaseVelocity(
  trackedVelocity: number,
  millisecondsSinceLastMove: number,
  decayMilliseconds = 90
): number {
  const velocity = Number.isFinite(trackedVelocity) ? trackedVelocity : 0;
  const idle = Math.max(0, Number.isFinite(millisecondsSinceLastMove) ? millisecondsSinceLastMove : 0);
  return velocity * Math.exp(-idle / Math.max(1, decayMilliseconds));
}

export function pageTurnRelease(
  input: SwipeInput,
  trackedVelocity: number,
  millisecondsSinceLastMove: number
): PageTurnRelease {
  return {
    direction: decidePageTurn(input),
    releaseVelocity: pageReleaseVelocity(trackedVelocity, millisecondsSinceLastMove)
  };
}

export function pageSettleMotion(
  currentOffset: number,
  targetOffset: number,
  releaseVelocity: number,
  minimumMilliseconds = 160,
  maximumMilliseconds = 480
): PageSettleMotion {
  const remaining = Math.abs(targetOffset - currentOffset);
  if (remaining < 0.5) return { durationMilliseconds: 1, initialControlY: 0.28 };
  const direction = Math.sign(targetOffset - currentOffset);
  const alignedVelocity = clamp((Number.isFinite(releaseVelocity) ? releaseVelocity : 0) * direction, 0, 3);
  const durationMilliseconds = clamp(
    remaining / Math.max(0.75, alignedVelocity),
    minimumMilliseconds,
    maximumMilliseconds
  );
  const normalizedInitialSlope = alignedVelocity * durationMilliseconds / remaining;
  return {
    durationMilliseconds,
    initialControlY: clamp(normalizedInitialSlope * 0.28, 0.08, 0.72)
  };
}

export function pinchCamera(
  initial: Camera,
  initialDistance: number,
  currentDistance: number,
  initialCenter: Point,
  currentCenter: Point,
  minimumScale = MIN_CAMERA_SCALE,
  maximumScale = MAX_CAMERA_SCALE
): Camera {
  const scale = clamp(initial.scale * currentDistance / Math.max(initialDistance, 1), minimumScale, maximumScale);
  const ratio = scale / initial.scale;
  return {
    scale,
    x: currentCenter.x - (initialCenter.x - initial.x) * ratio,
    y: currentCenter.y - (initialCenter.y - initial.y) * ratio
  };
}

export function isDoubleTap(previous: TapSample | undefined, current: TapSample, maximumDelay = 320, maximumDistance = 36): boolean {
  return previous !== undefined
    && current.at >= previous.at
    && current.at - previous.at <= maximumDelay
    && distance(previous.point, current.point) <= maximumDistance;
}

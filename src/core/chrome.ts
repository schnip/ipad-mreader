import { isDoubleTap } from "./gestures";
import type { TapSample } from "./gestures";
import type { Size } from "./layout";
import type { Point } from "./scene";

export type ReadingTapAction = "double-tap" | "defer-chrome" | "defer-previous-page" | "defer-next-page" | "remember";
export type ReadingTapRegion = "center" | "previous-page" | "next-page" | "none";

export interface ReadingTapDecision {
  action: ReadingTapAction;
  cancelPending: boolean;
}

export interface ReaderShortcutInput {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  typing: boolean;
}

export function isCenterRegion(point: Point, viewport: Size, regionFraction = 0.7): boolean {
  const fraction = Math.min(1, Math.max(0, regionFraction));
  const horizontalMargin = viewport.width * (1 - fraction) / 2;
  const verticalMargin = viewport.height * (1 - fraction) / 2;
  return point.x >= horizontalMargin
    && point.x <= viewport.width - horizontalMargin
    && point.y >= verticalMargin
    && point.y <= viewport.height - verticalMargin;
}

export function readingTapRegion(
  point: Point,
  viewport: Size,
  centerFraction = 0.7,
  edgeFraction = 0.14
): ReadingTapRegion {
  const edgeWidth = viewport.width * Math.min(0.25, Math.max(0, edgeFraction));
  if (point.x <= edgeWidth) return "previous-page";
  if (point.x >= viewport.width - edgeWidth) return "next-page";
  return isCenterRegion(point, viewport, centerFraction) ? "center" : "none";
}

export function decideReadingTap(
  previous: TapSample | undefined,
  current: TapSample,
  viewport: Size
): ReadingTapDecision {
  if (isDoubleTap(previous, current)) return { action: "double-tap", cancelPending: true };
  const region = readingTapRegion(current.point, viewport);
  const action: ReadingTapAction = region === "center"
    ? "defer-chrome"
    : region === "previous-page"
      ? "defer-previous-page"
      : region === "next-page"
        ? "defer-next-page"
        : "remember";
  return {
    action,
    cancelPending: previous !== undefined
  };
}

export function suppressReaderShortcutWhileTyping(input: ReaderShortcutInput): boolean {
  if (!input.typing) return false;
  if (input.key === "Escape") return false;
  return !((input.metaKey || input.ctrlKey) && input.key.toLowerCase() === "f");
}

export function panelScrollTop(scrollTop: number, touchDeltaY: number, scrollHeight: number, clientHeight: number): number {
  const maximum = Math.max(0, scrollHeight - clientHeight);
  const requested = (Number.isFinite(scrollTop) ? scrollTop : 0) - (Number.isFinite(touchDeltaY) ? touchDeltaY : 0);
  return Math.min(maximum, Math.max(0, requested));
}

export interface PanelMomentumStep {
  scrollTop: number;
  velocity: number;
  reachedBoundary: boolean;
}

export function stepPanelMomentum(
  scrollTop: number,
  velocity: number,
  elapsedMilliseconds: number,
  scrollHeight: number,
  clientHeight: number,
  decayMilliseconds = 340
): PanelMomentumStep {
  const elapsed = Math.min(50, Math.max(0, elapsedMilliseconds));
  const decay = Math.exp(-elapsed / Math.max(1, decayMilliseconds));
  const nextVelocity = velocity * decay;
  const requested = scrollTop + ((velocity + nextVelocity) / 2) * elapsed;
  const maximum = Math.max(0, scrollHeight - clientHeight);
  const constrained = Math.min(maximum, Math.max(0, requested));
  return {
    scrollTop: constrained,
    velocity: nextVelocity,
    reachedBoundary: Math.abs(constrained - requested) > 0.1
  };
}

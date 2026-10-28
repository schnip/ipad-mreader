import { clamp } from "./scene";

export type SemanticViewMode = "reading" | "grid";

export const GRID_ENTER_SCALE = 0.62;
export const GRID_EXIT_SCALE = 0.78;
export const GRID_REST_SCALE = 0.48;
export const MIN_SEMANTIC_SCALE = 0.34;

export interface SemanticTransform {
  x: number;
  y: number;
  scale: number;
}

export function semanticViewMode(mode: SemanticViewMode, scale: number): SemanticViewMode {
  if (mode === "reading" && scale <= GRID_ENTER_SCALE) return "grid";
  if (mode === "grid" && scale >= GRID_EXIT_SCALE) return "reading";
  return mode;
}

export function readingLayerOpacity(scale: number): number {
  return clamp((scale - GRID_ENTER_SCALE) / (GRID_EXIT_SCALE - GRID_ENTER_SCALE), 0, 1);
}

export function gridLayerOpacity(scale: number): number {
  return 1 - readingLayerOpacity(scale);
}

export function semanticScale(initialScale: number, initialDistance: number, currentDistance: number): number {
  return clamp(initialScale * currentDistance / Math.max(initialDistance, 1), MIN_SEMANTIC_SCALE, 1);
}

export function semanticTransitionProgress(scale: number, expandedScale = 1, restingScale = GRID_REST_SCALE): number {
  const span = Math.max(Number.EPSILON, expandedScale - restingScale);
  return clamp((expandedScale - scale) / span, 0, 1);
}

export function interpolateSemanticTransform(
  expanded: SemanticTransform,
  resting: SemanticTransform,
  progress: number
): SemanticTransform {
  const amount = clamp(progress, 0, 1);
  return {
    x: expanded.x + (resting.x - expanded.x) * amount,
    y: expanded.y + (resting.y - expanded.y) * amount,
    scale: expanded.scale + (resting.scale - expanded.scale) * amount
  };
}

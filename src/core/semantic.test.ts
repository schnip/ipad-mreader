import { describe, expect, it } from "vitest";
import { GRID_ENTER_SCALE, GRID_EXIT_SCALE, GRID_REST_SCALE, gridLayerOpacity, interpolateSemanticTransform, readingLayerOpacity, semanticScale, semanticTransitionProgress, semanticViewMode } from "./semantic";

describe("semantic zoom threshold", () => {
  it("enters and exits grid with hysteresis", () => {
    expect(semanticViewMode("reading", GRID_ENTER_SCALE)).toBe("grid");
    expect(semanticViewMode("grid", 0.7)).toBe("grid");
    expect(semanticViewMode("grid", GRID_EXIT_SCALE)).toBe("reading");
    expect(semanticViewMode("reading", 0.7)).toBe("reading");
  });

  it("cross-fades only inside the transition band", () => {
    expect(readingLayerOpacity(0.4)).toBe(0);
    expect(readingLayerOpacity(1)).toBe(1);
    expect(readingLayerOpacity(0.7)).toBeCloseTo(0.5);
    expect(gridLayerOpacity(0.7)).toBeCloseTo(0.5);
  });

  it("tracks pinch distance and bounds semantic scale", () => {
    expect(semanticScale(1, 200, 100)).toBe(0.5);
    expect(semanticScale(0.48, 100, 300)).toBe(1);
    expect(semanticScale(1, 100, 1)).toBe(0.34);
  });

  it("interpolates a focused thumbnail from expanded page space to grid rest", () => {
    expect(semanticTransitionProgress(1)).toBe(0);
    expect(semanticTransitionProgress(GRID_REST_SCALE)).toBe(1);
    expect(interpolateSemanticTransform(
      { x: -100, y: -200, scale: 4 },
      { x: 0, y: -800, scale: 1 },
      0.5
    )).toEqual({ x: -50, y: -500, scale: 2.5 });
  });
});

import { describe, expect, it } from "vitest";
import { characterIndexAt, decideSwipe, distance, midpoint, pointInLocalSpace, zoomAroundPoint } from "./gesture-math";

describe("gesture math", () => {
  it("measures two-finger geometry", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 2, y: 8 }, { x: 6, y: 4 })).toEqual({ x: 4, y: 6 });
  });

  it("keeps the pinch focal point stationary", () => {
    const result = zoomAroundPoint(
      { x: 0, y: 0, scale: 1 },
      2,
      { x: 100, y: 200 },
      { x: 100, y: 200 }
    );
    expect(result).toEqual({ x: -100, y: -200, scale: 2 });
  });

  it("includes midpoint movement while pinching", () => {
    expect(
      zoomAroundPoint(
        { x: 10, y: 20, scale: 2 },
        1,
        { x: 100, y: 100 },
        { x: 125, y: 90 }
      )
    ).toEqual({ x: 35, y: 10, scale: 2 });
  });

  it("clamps camera scale", () => {
    expect(zoomAroundPoint({ x: 0, y: 0, scale: 1 }, 100, { x: 0, y: 0 }, { x: 0, y: 0 }).scale).toBe(6);
    expect(zoomAroundPoint({ x: 0, y: 0, scale: 2 }, 0.01, { x: 0, y: 0 }, { x: 0, y: 0 }).scale).toBe(1);
  });

  it("maps a horizontal hit to a character and clamps edge hits", () => {
    expect(characterIndexAt(125, 100, 100, 10)).toBe(2);
    expect(characterIndexAt(50, 100, 100, 10)).toBe(0);
    expect(characterIndexAt(250, 100, 100, 10)).toBe(9);
    expect(characterIndexAt(125, 100, 100, 0)).toBeUndefined();
  });

  it("maps transformed screen coordinates back into local canvas space", () => {
    expect(pointInLocalSpace(
      { x: 350, y: 260 },
      { left: 50, top: 20, width: 600, height: 480 },
      300,
      240
    )).toEqual({ x: 150, y: 120 });
  });

  it("accepts deliberate or fast horizontal swipes", () => {
    expect(decideSwipe({ deltaX: -220, deltaY: 30, elapsedMs: 700, viewportWidth: 800 })).toBe(1);
    expect(decideSwipe({ deltaX: 65, deltaY: 3, elapsedMs: 80, viewportWidth: 800 })).toBe(-1);
  });

  it("rejects vertical and indecisive movement", () => {
    expect(decideSwipe({ deltaX: 100, deltaY: 120, elapsedMs: 100, viewportWidth: 800 })).toBe(0);
    expect(decideSwipe({ deltaX: 30, deltaY: 2, elapsedMs: 500, viewportWidth: 800 })).toBe(0);
  });
});

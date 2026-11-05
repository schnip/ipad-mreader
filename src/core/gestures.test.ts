import { describe, expect, it } from "vitest";
import { decidePageTurn, distance, gestureIntent, isDoubleTap, midpoint, pageReleaseVelocity, pageSettleMotion, pageTurnDragOffset, pageTurnRelease, pinchCamera } from "./gestures";

describe("reader gestures", () => {
  it("measures pinch geometry", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 2, y: 8 }, { x: 6, y: 4 })).toEqual({ x: 4, y: 6 });
  });

  it("defers intent, turns at fit, and pans when zoomed", () => {
    expect(gestureIntent({ x: 2, y: 1 }, 1)).toBe("undecided");
    expect(gestureIntent({ x: 40, y: 5 }, 1)).toBe("page-turn");
    expect(gestureIntent({ x: 5, y: 40 }, 1)).toBe("undecided");
    expect(gestureIntent({ x: 5, y: 40 }, 1.1)).toBe("pan");
  });

  it("accepts deliberate or fast horizontal page turns", () => {
    expect(decidePageTurn({ deltaX: -220, deltaY: 30, elapsedMs: 700, viewportWidth: 800 })).toBe(1);
    expect(decidePageTurn({ deltaX: 65, deltaY: 3, elapsedMs: 80, viewportWidth: 800 })).toBe(-1);
  });

  it("rejects vertical and indecisive movement", () => {
    expect(decidePageTurn({ deltaX: 100, deltaY: 120, elapsedMs: 100, viewportWidth: 800 })).toBe(0);
    expect(decidePageTurn({ deltaX: 30, deltaY: 2, elapsedMs: 500, viewportWidth: 800 })).toBe(0);
  });

  it("tracks the finger fully when a page exists and resists a boundary", () => {
    expect(pageTurnDragOffset(-120, true)).toBe(-120);
    expect(pageTurnDragOffset(100, false)).toBe(50);
    expect(pageTurnDragOffset(-100, false)).toBe(-50);
  });

  it("continues a release at its tracked velocity and lets a slow release settle gently", () => {
    const slow = pageSettleMotion(-160, -800, -0.4);
    const fast = pageSettleMotion(-160, -800, -2);
    expect(slow.durationMilliseconds).toBe(480);
    expect(fast.durationMilliseconds).toBe(320);
    expect(fast.initialControlY).toBeGreaterThan(slow.initialControlY);
    expect(pageSettleMotion(-700, -800, -0.2).durationMilliseconds).toBe(160);
    expect(pageSettleMotion(0, -2000, 0).durationMilliseconds).toBe(480);
  });

  it("decays stale release velocity when the finger pauses before lifting", () => {
    expect(pageReleaseVelocity(-2, 0)).toBe(-2);
    expect(pageReleaseVelocity(-2, 90)).toBeCloseTo(-2 / Math.E);
    expect(pageReleaseVelocity(Number.NaN, 10)).toBe(0);
  });

  it("combines repeated quick page-turn decisions with independent release velocities", () => {
    const forward = pageTurnRelease(
      { deltaX: -70, deltaY: 2, elapsedMs: 80, viewportWidth: 800 },
      -1.8,
      0
    );
    const backward = pageTurnRelease(
      { deltaX: 75, deltaY: 3, elapsedMs: 75, viewportWidth: 800 },
      1.6,
      45
    );
    const repeatedForward = pageTurnRelease(
      { deltaX: -70, deltaY: 2, elapsedMs: 80, viewportWidth: 800 },
      -1.8,
      0
    );

    expect(forward).toEqual({ direction: 1, releaseVelocity: -1.8 });
    expect(backward.direction).toBe(-1);
    expect(backward.releaseVelocity).toBeCloseTo(1.6 / Math.sqrt(Math.E));
    expect(repeatedForward).toEqual(forward);
  });

  it("rejects a non-horizontal release while still returning its decayed settle velocity", () => {
    const release = pageTurnRelease(
      { deltaX: 90, deltaY: 100, elapsedMs: 100, viewportWidth: 800 },
      1.2,
      90
    );

    expect(release.direction).toBe(0);
    expect(release.releaseVelocity).toBeCloseTo(1.2 / Math.E);
  });

  it("keeps the initial pinch focus under the moving midpoint", () => {
    expect(pinchCamera(
      { x: 0, y: 0, scale: 1 },
      100,
      200,
      { x: 100, y: 200 },
      { x: 120, y: 180 }
    )).toEqual({ x: -80, y: -220, scale: 2 });
  });

  it("recognizes only nearby taps inside the time window", () => {
    const previous = { at: 100, point: { x: 50, y: 50 } };
    expect(isDoubleTap(previous, { at: 350, point: { x: 60, y: 55 } })).toBe(true);
    expect(isDoubleTap(previous, { at: 500, point: { x: 60, y: 55 } })).toBe(false);
    expect(isDoubleTap(previous, { at: 200, point: { x: 100, y: 100 } })).toBe(false);
    expect(isDoubleTap(undefined, { at: 200, point: { x: 50, y: 50 } })).toBe(false);
  });
});

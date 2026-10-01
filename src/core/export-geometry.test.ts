import { describe, expect, it } from "vitest";
import { normalizeRotation, userPointFromNormalized, userPointFromView, userRectFromNormalized, viewportMatrix, viewportSize, type UserPoint, type ViewMatrix } from "./export-geometry";

const box = { x1: 0, y1: 0, x2: 612, y2: 792 };

function applyViewMatrix(matrix: ViewMatrix, point: UserPoint): UserPoint {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

describe("export geometry", () => {
  it("normalizes rotations to quarter turns", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(270)).toBe(270);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(37)).toBe(0);
    expect(normalizeRotation(Number.NaN)).toBe(0);
    expect(normalizeRotation(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("reports rotated viewport sizes", () => {
    expect(viewportSize(box, 0)).toEqual({ width: 612, height: 792 });
    expect(viewportSize(box, 180)).toEqual({ width: 612, height: 792 });
    expect(viewportSize(box, 90)).toEqual({ width: 792, height: 612 });
    expect(viewportSize(box, 270)).toEqual({ width: 792, height: 612 });
  });

  it("maps normalized unrotated geometry into user space", () => {
    const topLeft = userPointFromNormalized(box, 0, { x: 0, y: 0 });
    expect(topLeft?.x).toBeCloseTo(0);
    expect(topLeft?.y).toBeCloseTo(792);
    const bottomRight = userPointFromNormalized(box, 0, { x: 1, y: 1 });
    expect(bottomRight?.x).toBeCloseTo(612);
    expect(bottomRight?.y).toBeCloseTo(0);
    const rect = userRectFromNormalized(box, 0, { x: 0.1, y: 0.1, width: 0.2, height: 0.05 });
    expect(rect?.x).toBeCloseTo(61.2);
    expect(rect?.y).toBeCloseTo(673.2);
    expect(rect?.width).toBeCloseTo(122.4);
    expect(rect?.height).toBeCloseTo(39.6);
  });

  it("preserves a non-zero view-box origin", () => {
    const offsetBox = { x1: 9, y1: 9, x2: 621, y2: 801 };
    expect(userPointFromNormalized(offsetBox, 0, { x: 0, y: 0 })).toEqual({ x: 9, y: 801 });
    expect(userPointFromNormalized(offsetBox, 0, { x: 1, y: 1 })).toEqual({ x: 621, y: 9 });
  });

  it("maps rotation 90 and round-trips mid-page points at every quarter turn", () => {
    const rotatedTopLeft = userPointFromNormalized(box, 90, { x: 0, y: 0 });
    expect(rotatedTopLeft?.x).toBeCloseTo(0);
    expect(rotatedTopLeft?.y).toBeCloseTo(0);
    for (const rotation of [0, 90, 180, 270]) {
      const size = viewportSize(box, rotation);
      const userPoint = userPointFromNormalized(box, rotation, { x: 0.3, y: 0.7 });
      expect(userPoint).toBeDefined();
      if (!userPoint) throw new Error("Expected a user-space point.");
      const viewPoint = applyViewMatrix(viewportMatrix(box, rotation), userPoint);
      expect(viewPoint.x).toBeCloseTo(0.3 * size.width);
      expect(viewPoint.y).toBeCloseTo(0.7 * size.height);
    }
  });

  it("rejects degenerate matrices and non-finite view coordinates", () => {
    expect(userPointFromView([0, 0, 0, 0, 0, 0], { x: 1, y: 1 })).toBeUndefined();
    expect(userPointFromView([1, 0, 0, 1, 0, 0], { x: Number.NaN, y: 1 })).toBeUndefined();
  });
});

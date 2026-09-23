import { describe, expect, it } from "vitest";
import { cameraForPagePoint, constrainCamera, moveCamera, normalizedPageCenter, sceneToScreen, screenToScene, zoomCameraAt } from "./scene";
import { unionPageLayouts } from "./layout";

const page = { x: 50, y: 50, width: 100, height: 100, scale: 1 };
const viewport = { width: 200, height: 200 };

describe("scene camera", () => {
  it("round-trips scene and screen coordinates", () => {
    const camera = { x: -30, y: 45, scale: 2.5 };
    const screen = sceneToScreen({ x: 18, y: 22 }, camera);
    expect(screenToScene(screen, camera)).toEqual({ x: 18, y: 22 });
  });

  it("keeps the focal point stationary while zooming", () => {
    const initial = { x: 10, y: -20, scale: 1 };
    const focus = { x: 80, y: 90 };
    const before = screenToScene(focus, initial);
    const zoomed = zoomCameraAt(initial, 3, focus);
    expect(screenToScene(focus, zoomed)).toEqual(before);
  });

  it("clamps zoom and centers a page smaller than the viewport", () => {
    expect(zoomCameraAt({ x: 0, y: 0, scale: 1 }, 99, { x: 0, y: 0 }).scale).toBe(6);
    expect(constrainCamera({ x: 60, y: -80, scale: 1 }, page, viewport)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("constrains a zoomed page without exposing space beyond its edges", () => {
    expect(constrainCamera({ x: 500, y: 500, scale: 2 }, page, viewport)).toEqual({ x: -84, y: -84, scale: 2 });
    expect(constrainCamera({ x: -500, y: -500, scale: 2 }, page, viewport)).toEqual({ x: -116, y: -116, scale: 2 });
  });

  it("builds a camera around a page point and reports its normalized center", () => {
    const camera = cameraForPagePoint({ x: 75, y: 125 }, { x: 100, y: 100 }, 2);
    expect(camera).toEqual({ x: -50, y: -150, scale: 2 });
    expect(normalizedPageCenter(camera, page, viewport)).toEqual({ x: 0.25, y: 0.75 });
  });

  it("moves without changing scale", () => {
    expect(moveCamera({ x: 1, y: 2, scale: 3 }, { x: 4, y: -5 })).toEqual({ x: 5, y: -3, scale: 3 });
  });

  it("constrains a zoomed camera against the union of a whole spread", () => {
    const spread = unionPageLayouts([
      { x: 10, y: 30, width: 80, height: 140, scale: 1 },
      { x: 110, y: 50, width: 80, height: 100, scale: 1 }
    ]);
    if (!spread) throw new Error("Expected spread bounds.");
    expect(constrainCamera({ x: 500, y: 500, scale: 2 }, spread, viewport)).toEqual({ x: -4, y: -44, scale: 2 });
    expect(constrainCamera({ x: -500, y: -500, scale: 2 }, spread, viewport)).toEqual({ x: -196, y: -156, scale: 2 });
  });
});

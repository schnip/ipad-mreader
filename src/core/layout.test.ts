import { describe, expect, it } from "vitest";
import { adjacentSpreadSlots, continuousPageAtViewportCenter, continuousScrollForPage, hasMeaningfulZoomDelta, layoutContinuous, layoutSinglePage, layoutSpread, nextSpreadPage, normalizeReaderLayout, pageWidthZoom, sameLayout, shouldRefreshContinuousWindow, spreadPageNumbers, stepContinuousMomentum, trackContinuousVelocity, unionPageLayouts, visibleContinuousPages } from "./layout";

describe("single-page layout", () => {
  it("fits and centers a portrait page inside safe areas and margins", () => {
    const layout = layoutSinglePage(
      { width: 400, height: 800 },
      { width: 800, height: 600 },
      { top: 20, right: 20, bottom: 20, left: 20 }
    );
    expect(layout).toEqual({ x: 268, y: 36, width: 264, height: 528, scale: 0.66 });
  });

  it("fits a landscape page by width", () => {
    const layout = layoutSinglePage({ width: 1000, height: 500 }, { width: 800, height: 600 });
    expect(layout.scale).toBeCloseTo(0.768);
    expect(layout.width).toBeCloseTo(768);
    expect(layout.x).toBeCloseTo(16);
    expect(layout.y).toBeCloseTo(108);
  });

  it("sanitizes invalid source dimensions", () => {
    const layout = layoutSinglePage({ width: 0, height: Number.NaN }, { width: 100, height: 100 });
    expect(layout.width).toBe(68);
    expect(layout.height).toBe(68);
    expect(layout.scale).toBe(68);
  });

  it("calculates page-width zoom relative to fit-page layout", () => {
    const layout = layoutSinglePage({ width: 600, height: 1200 }, { width: 800, height: 600 });
    expect(pageWidthZoom(layout, { width: 800, height: 600 })).toBeCloseTo(768 / 284);
  });

  it("compares layouts with a configurable tolerance", () => {
    const first = { x: 1, y: 2, width: 3, height: 4, scale: 0.5 };
    expect(sameLayout(first, { ...first, x: 1.005 })).toBe(true);
    expect(sameLayout(first, { ...first, x: 1.02 })).toBe(false);
  });
});

describe("P4 reader layouts", () => {
  it("normalizes layout values and suppresses insignificant width zoom", () => {
    expect(normalizeReaderLayout("continuous")).toBe("continuous");
    expect(normalizeReaderLayout("unknown")).toBe("single");
    expect(hasMeaningfulZoomDelta(1, 1.08)).toBe(false);
    expect(hasMeaningfulZoomDelta(1, 1.1)).toBe(true);
    expect(hasMeaningfulZoomDelta(0, 2)).toBe(false);
  });

  it("groups regular and cover-aware spreads including odd endings", () => {
    expect(spreadPageNumbers(2, 5, "twoUp")).toEqual([1, 2]);
    expect(spreadPageNumbers(5, 5, "twoUp")).toEqual([5]);
    expect(spreadPageNumbers(1, 6, "twoUpCover")).toEqual([1]);
    expect(spreadPageNumbers(3, 6, "twoUpCover")).toEqual([2, 3]);
    expect(nextSpreadPage(1, 6, "twoUpCover", 1)).toBe(2);
    expect(nextSpreadPage(6, 6, "twoUpCover", -1)).toBe(4);
  });

  it("describes bounded previous/current/next spread slots at regular and cover boundaries", () => {
    expect(adjacentSpreadSlots(3, 5, "twoUp")).toEqual([
      { slot: -1, anchorPage: 1, pages: [1, 2] },
      { slot: 0, anchorPage: 3, pages: [3, 4] },
      { slot: 1, anchorPage: 5, pages: [5] }
    ]);
    expect(adjacentSpreadSlots(1, 6, "twoUpCover")).toEqual([
      { slot: 0, anchorPage: 1, pages: [1] },
      { slot: 1, anchorPage: 2, pages: [2, 3] }
    ]);
    expect(adjacentSpreadSlots(6, 6, "twoUpCover").map((slot) => slot.pages)).toEqual([[4, 5], [6]]);
  });

  it("fits mixed portrait and landscape pages together inside safe areas", () => {
    const spread = layoutSpread([
      { pageNumber: 2, size: { width: 600, height: 900 } },
      { pageNumber: 3, size: { width: 1000, height: 500 } }
    ], { width: 1180, height: 820 }, { top: 24, right: 20, bottom: 16, left: 30 });
    expect(spread.pages).toHaveLength(2);
    expect(spread.pages[0]?.x).toBeGreaterThanOrEqual(46);
    expect((spread.pages[1]?.x ?? 0) + (spread.pages[1]?.width ?? 0)).toBeLessThanOrEqual(1144);
    expect(spread.pages[0]?.height).toBeGreaterThan(spread.pages[1]?.height ?? 0);
  });

  it("unions mixed spread pages for whole-spread camera bounds", () => {
    expect(unionPageLayouts([
      { x: 20, y: 40, width: 180, height: 300, scale: 0.5 },
      { x: 212, y: 80, width: 260, height: 180, scale: 0.5 }
    ])).toEqual({ x: 20, y: 40, width: 452, height: 300, scale: 0.5 });
    expect(unionPageLayouts([])).toBeUndefined();
  });

  it("virtualizes a 792-page continuous document to bounded visible overscan", () => {
    const viewport = { width: 768, height: 1024 };
    const sizes = Array.from({ length: 792 }, (_, index) => index % 7 === 0 ? { width: 900, height: 600 } : { width: 600, height: 900 });
    const layout = layoutContinuous(sizes, viewport, { top: 24, bottom: 20 });
    const scroll = continuousScrollForPage(layout, 500, viewport);
    const visible = visibleContinuousPages(layout, scroll, viewport, 1);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(10);
    expect(continuousPageAtViewportCenter(layout, scroll, viewport)).toBe(500);
    expect(layout.pages).toHaveLength(792);
  });

  it("tracks, decays, bounds, and settles continuous release momentum", () => {
    const velocity = trackContinuousVelocity(0, 40, 20, 0.5);
    expect(velocity).toBe(1);
    const moving = stepContinuousMomentum(200, velocity, 16, { minimum: 0, maximum: 1000 });
    expect(moving.scroll).toBeGreaterThan(200);
    expect(moving.velocity).toBeGreaterThan(0);
    expect(moving.velocity).toBeLessThan(velocity);
    expect(moving.settled).toBe(false);
    expect(stepContinuousMomentum(995, 2, 16, { minimum: 0, maximum: 1000 })).toEqual({
      scroll: 1000,
      velocity: 0,
      reachedBound: true,
      settled: true
    });
    expect(shouldRefreshContinuousWindow(399, 0, 800)).toBe(false);
    expect(shouldRefreshContinuousWindow(400, 0, 800)).toBe(true);
  });
});

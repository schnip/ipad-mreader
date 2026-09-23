import { describe, expect, it } from "vitest";
import { constrainGridOffset, dragGridOffset, gridOffsetBounds, gridOffsetForPage, gridPageAtPoint, layoutGrid, nearestGridPage, rubberBandDisplacement, shouldRefreshGridWindow, stepGridMomentum, stepGridSpring, visibleGridPages } from "./grid";

describe("thumbnail grid geometry", () => {
  it("adapts row count to the current viewport height", () => {
    const sizes = Array.from({ length: 12 }, () => ({ width: 600, height: 900 }));
    expect(layoutGrid(sizes, { width: 768, height: 1024 }).rows).toBe(4);
    expect(layoutGrid(sizes, { width: 1180, height: 820 }).rows).toBe(3);
  });

  it("preserves mixed page aspect ratios within aligned rows", () => {
    const grid = layoutGrid([
      { width: 600, height: 900 },
      { width: 1000, height: 500 },
      { width: 500, height: 1200 },
      { width: 900, height: 600 }
    ], { width: 640, height: 900 }, {}, { minimumRows: 2, maximumRows: 2 });
    expect(grid.pages[0]?.width).toBeLessThan(grid.pages[1]?.width ?? 0);
    expect(grid.pages[2]?.width).toBeLessThan(grid.pages[3]?.width ?? 0);
    expect(grid.pages[0]?.x).toBeLessThan(grid.pages[2]?.x ?? 0);
    expect(grid.pages.every((page) => page.height <= 421)).toBe(true);
  });

  it("honors safe areas and invalid source dimensions", () => {
    const grid = layoutGrid([{ width: 0, height: Number.NaN }], { width: 500, height: 800 }, { top: 30, left: 20, right: 10 });
    expect(grid.pages[0]?.x).toBeGreaterThanOrEqual(40);
    expect(grid.pages[0]?.y).toBeGreaterThanOrEqual(50);
    expect(grid.pages[0]?.width).toBeGreaterThan(0);
  });

  it("constrains long grids and centers short grids", () => {
    const long = layoutGrid(Array.from({ length: 40 }, () => ({ width: 600, height: 900 })), { width: 500, height: 700 });
    expect(constrainGridOffset(999, long, { width: 500, height: 700 })).toBe(12);
    expect(constrainGridOffset(-99999, long, { width: 500, height: 700 })).toBe(488 - long.width);
    const short = layoutGrid([{ width: 600, height: 900 }], { width: 500, height: 1000 });
    expect(constrainGridOffset(200, short, { width: 500, height: 1000 })).toBeCloseTo((500 - short.width) / 2);
  });

  it("centers a requested page while respecting the end bounds", () => {
    const grid = layoutGrid(Array.from({ length: 30 }, () => ({ width: 600, height: 900 })), { width: 600, height: 800 });
    const offset = gridOffsetForPage(grid, 15, { width: 600, height: 800 });
    const page = grid.pages[14];
    expect((page?.x ?? 0) + (page?.width ?? 0) / 2 + offset).toBeCloseTo(300);
    expect(gridOffsetForPage(grid, 30, { width: 600, height: 800 })).toBe(588 - grid.width);
  });

  it("schedules only visible pages and bounded overscan", () => {
    const viewport = { width: 600, height: 800 };
    const grid = layoutGrid(Array.from({ length: 792 }, () => ({ width: 600, height: 900 })), viewport);
    const visible = visibleGridPages(grid, -5000, viewport, 1);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(40);
    expect(visible.every((page) => page.x - 5000 + page.width >= -600 && page.x - 5000 <= 1200)).toBe(true);
  });

  it("refreshes a virtual window only after a bounded drag distance", () => {
    expect(shouldRefreshGridWindow(-100, Number.NaN, 800)).toBe(true);
    expect(shouldRefreshGridWindow(-399, 0, 800)).toBe(false);
    expect(shouldRefreshGridWindow(-400, 0, 800)).toBe(true);
  });

  it("hit-tests thumbnails and chooses a nearby focus", () => {
    const grid = layoutGrid(Array.from({ length: 8 }, () => ({ width: 600, height: 900 })), { width: 600, height: 800 });
    const page = grid.pages[3];
    if (!page) throw new Error("Expected page layout.");
    const point = { x: page.x + page.width / 2 - 100, y: page.y + page.height / 2 };
    expect(gridPageAtPoint(grid, -100, point)).toBe(4);
    expect(nearestGridPage(grid, -100, point)).toBe(4);
    expect(gridPageAtPoint(grid, -100, { x: 0, y: 0 })).toBeUndefined();
  });

  it("advances and decays horizontal momentum", () => {
    const step = stepGridMomentum(-500, -2, 16);
    expect(step.offset).toBeLessThan(-500);
    expect(step.velocity).toBeGreaterThan(-2);
    expect(step.velocity).toBeLessThan(0);
  });

  it("keeps legal grid state in bounds while applying a subtle bounded rubber band", () => {
    const bounds = { minimum: -500, maximum: 12 };
    const dragged = dragGridOffset(12, 0, 200, bounds);
    expect(dragged.legalOffset).toBe(12);
    expect(dragged.overscroll).toBe(200);
    expect(dragged.visualOffset).toBeGreaterThan(12);
    expect(dragged.visualOffset).toBeLessThanOrEqual(48);
    expect(rubberBandDisplacement(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("consumes overscroll before moving back through the legal range", () => {
    const bounds = { minimum: -500, maximum: 12 };
    expect(dragGridOffset(12, 80, -30, bounds)).toMatchObject({ legalOffset: 12, overscroll: 50 });
    expect(dragGridOffset(12, 20, -50, bounds)).toMatchObject({ legalOffset: -18, overscroll: 0, visualOffset: -18 });
  });

  it("derives stable bounds for long and short grids", () => {
    const viewport = { width: 500, height: 700 };
    const long = layoutGrid(Array.from({ length: 40 }, () => ({ width: 600, height: 900 })), viewport);
    expect(gridOffsetBounds(long, viewport)).toEqual({ minimum: 488 - long.width, maximum: 12 });
    const short = layoutGrid([{ width: 600, height: 900 }], { width: 500, height: 1000 });
    const shortBounds = gridOffsetBounds(short, { width: 500, height: 1000 });
    expect(shortBounds.minimum).toBe(shortBounds.maximum);
  });

  it("settles spring displacement without escaping its visual bound", () => {
    let state = { displacement: 30, velocity: 0, settled: false };
    for (let index = 0; index < 120 && !state.settled; index += 1) {
      state = stepGridSpring(state.displacement, state.velocity, 16);
      expect(Math.abs(state.displacement)).toBeLessThanOrEqual(36);
    }
    expect(state).toEqual({ displacement: 0, velocity: 0, settled: true });
  });
});

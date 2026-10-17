import { describe, expect, it } from "vitest";
import { continuousPageAtViewportCenter, layoutContinuous, visibleContinuousPages } from "./layout";
import type { ContinuousLayout, Size } from "./layout";

function linearCenter(layout: ContinuousLayout, scrollY: number, viewport: Size): number {
  const center = scrollY + viewport.height / 2;
  let closest = layout.pages[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const page of layout.pages) {
    const next = Math.abs(page.y + page.height / 2 - center);
    if (next < distance) {
      closest = page;
      distance = next;
    }
  }
  return closest?.pageNumber ?? 1;
}

function linearVisible(layout: ContinuousLayout, scrollY: number, viewport: Size, overscan = 1): number[] {
  const extra = Math.max(0, overscan) * Math.max(1, viewport.height);
  return layout.pages
    .filter((page) => page.y + page.height >= scrollY - extra && page.y <= scrollY + viewport.height + extra)
    .map((page) => page.pageNumber);
}

describe("continuous lookups", () => {
  const viewport = { width: 820, height: 1180 };
  const sizes = Array.from({ length: 120 }, (_, index) => (index % 7 === 3 ? { width: 842, height: 595 } : { width: 612, height: 792 }));
  const layout = layoutContinuous(sizes, viewport, { top: 24, bottom: 20 });

  it("matches a linear scan for the centered page and visible window at every scroll offset", () => {
    for (let scroll = -2000; scroll <= layout.height + 2000; scroll += 137) {
      expect(continuousPageAtViewportCenter(layout, scroll, viewport)).toBe(linearCenter(layout, scroll, viewport));
      expect(visibleContinuousPages(layout, scroll, viewport).map((page) => page.pageNumber)).toEqual(linearVisible(layout, scroll, viewport));
      expect(visibleContinuousPages(layout, scroll, viewport, 0).map((page) => page.pageNumber)).toEqual(linearVisible(layout, scroll, viewport, 0));
    }
  });

  it("handles empty layouts and non-finite scroll", () => {
    const empty = layoutContinuous([], viewport);
    expect(continuousPageAtViewportCenter(empty, 0, viewport)).toBe(1);
    expect(visibleContinuousPages(empty, 0, viewport)).toEqual([]);
    expect(continuousPageAtViewportCenter(layout, Number.NaN, viewport)).toBe(1);
    expect(visibleContinuousPages(layout, Number.NaN, viewport)).toEqual([]);
  });
});

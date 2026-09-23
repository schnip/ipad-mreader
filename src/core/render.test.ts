import { describe, expect, it, vi } from "vitest";
import { MAX_RENDER_DIMENSION, MAX_RENDER_PIXELS, WeightedLruCache, boundedRasterMultiplier, orderRenderSpecs, renderCacheKey } from "./render";
import type { PageRenderSpec } from "./render";

describe("settled renderer helpers", () => {
  it("evicts the least recently used entry by count", () => {
    const disposed = vi.fn();
    const cache = new WeightedLruCache<string, string>(2, 100, disposed);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C", 10);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(disposed).toHaveBeenCalledWith("B");
  });

  it("enforces its weight budget and clears resources", () => {
    const disposed = vi.fn();
    const cache = new WeightedLruCache<string, string>(5, 5, disposed);
    cache.set("a", "A", 3);
    cache.set("b", "B", 3);
    expect(cache.weight).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.set("large", "L", 6)).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
    expect(disposed).toHaveBeenCalledWith("B");
  });

  it("orders current-page work before adjacent work", () => {
    const canvas = {} as HTMLCanvasElement;
    const spec = (pageNumber: number, priority: number): PageRenderSpec => ({
      pageNumber,
      priority,
      canvas,
      cssWidth: 100,
      cssHeight: 200,
      pdfScale: 1,
      dpr: 2
    });
    expect(orderRenderSpecs([spec(9, 1), spec(10, 0), spec(11, 1)]).map((item) => item.pageNumber)).toEqual([10, 9, 11]);
  });

  it("uses document, page, scale, and DPR in cache identity", () => {
    expect(renderCacheKey("doc", { pageNumber: 3, pdfScale: 1.2344, dpr: 2 })).toBe("doc:3:1234:200");
    expect(renderCacheKey("doc", { pageNumber: 3, pdfScale: 1.2346, dpr: 2 })).toBe("doc:3:1235:200");
  });

  it("caps high-zoom surfaces before allocating a canvas", () => {
    expect(boundedRasterMultiplier(1000, 1500, 1, 2)).toBe(1);
    const multiplier = boundedRasterMultiplier(1600, 2200, 6, 2.5);
    const width = 1600 * 6 * 2.5 * multiplier;
    const height = 2200 * 6 * 2.5 * multiplier;
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
    expect(width * height).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1);
  });
});

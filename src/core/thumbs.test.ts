import { describe, expect, it } from "vitest";
import { StaleGeneration, orderThumbnailSpecs, thumbnailCacheKey, thumbnailRasterDpr } from "./thumbs";
import type { ThumbnailRenderSpec } from "./thumbs";

const canvas = {} as HTMLCanvasElement;
const spec = (pageNumber: number, priority: number): ThumbnailRenderSpec => ({
  pageNumber,
  priority,
  canvas,
  cssWidth: 120,
  cssHeight: 180,
  dpr: 1.5
});

describe("thumbnail scheduling helpers", () => {
  it("orders focused and nearby work deterministically", () => {
    expect(orderThumbnailSpecs([spec(8, 2), spec(7, 0), spec(6, 1)]).map((item) => item.pageNumber)).toEqual([7, 6, 8]);
  });

  it("keys cache entries by document, page, and raster dimensions", () => {
    expect(thumbnailCacheKey("book", spec(4, 0))).toBe("book:4:180x270");
    expect(thumbnailCacheKey("book", { ...spec(4, 0), dpr: 2 })).toBe("book:4:180x270");
  });

  it("allows bounded low-resolution prefetch rasters", () => {
    expect(thumbnailRasterDpr(0.6)).toBe(0.6);
    expect(thumbnailRasterDpr(0.1)).toBe(0.5);
    expect(thumbnailRasterDpr(Number.NaN)).toBe(1);
  });

  it("invalidates stale generations on every new schedule", () => {
    const generations = new StaleGeneration();
    const first = generations.next();
    expect(generations.isCurrent(first)).toBe(true);
    const second = generations.next();
    expect(generations.isCurrent(first)).toBe(false);
    expect(generations.isCurrent(second)).toBe(true);
  });
});

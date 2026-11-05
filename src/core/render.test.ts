import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfDocument, PdfRenderJob } from "./doc";
import { MAX_RENDER_DIMENSION, MAX_RENDER_PIXELS, SettledPageRenderer, WeightedLruCache, boundedRasterMultiplier, orderRenderSpecs, rasterDpr, releaseCanvas, renderCacheKey } from "./render";
import type { PageRenderSpec } from "./render";

interface FakeCanvas {
  width: number;
  height: number;
  hidden: boolean;
  style: Record<string, string>;
  draws: unknown[];
  getContext(): { drawImage(source: unknown): void };
}

function fakeCanvas(): FakeCanvas {
  const canvas: FakeCanvas = {
    width: 300,
    height: 150,
    hidden: true,
    style: {},
    draws: [],
    getContext: () => ({ drawImage: (source: unknown) => canvas.draws.push(source) })
  };
  return canvas;
}

interface Deferred {
  resolve(): void;
  reject(error: Error): void;
}

/** A PdfDocument whose page renders complete only when the test says so. */
function fakeDocument(): { pdf: PdfDocument; renders: Deferred[]; cancelled: number[] } {
  const renders: Deferred[] = [];
  const cancelled: number[] = [];
  const pdf = {
    descriptor: { id: "doc", name: "doc.pdf", byteLength: 1 },
    page: (pageNumber: number) => Promise.resolve({
      size: { width: 100, height: 200 },
      render(canvas: FakeCanvas): PdfRenderJob {
        canvas.width = 10;
        canvas.height = 20;
        let deferred: Deferred | undefined;
        const promise = new Promise<void>((resolve, reject) => { deferred = { resolve, reject }; });
        if (deferred) renders.push(deferred);
        return {
          width: 10,
          height: 20,
          promise,
          cancel: () => {
            cancelled.push(pageNumber);
            deferred?.reject(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }));
          }
        };
      }
    })
  } as unknown as PdfDocument;
  return { pdf, renders, cancelled };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const spec = (pageNumber: number, priority: number, canvas: FakeCanvas = fakeCanvas()): PageRenderSpec => ({
  pageNumber,
  priority,
  canvas: canvas as unknown as HTMLCanvasElement,
  cssWidth: 100,
  cssHeight: 200,
  pdfScale: 1,
  dpr: 2
});

describe("settled renderer helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it("keeps the existing entry when a replacement can never fit", () => {
    const disposed = vi.fn();
    const cache = new WeightedLruCache<string, string>(4, 10, disposed);
    cache.set("a", "A", 5);
    expect(cache.set("a", "A2", 50)).toBe(false);
    expect(cache.get("a")).toBe("A");
    expect(cache.weight).toBe(5);
    expect(disposed).not.toHaveBeenCalled();
  });

  it("replaces an entry and disposes the previous value", () => {
    const disposed = vi.fn();
    const cache = new WeightedLruCache<string, string>(4, 10, disposed);
    cache.set("a", "A", 5);
    cache.set("a", "A2", 3);
    expect(cache.get("a")).toBe("A2");
    expect(cache.weight).toBe(3);
    expect(disposed).toHaveBeenCalledWith("A");
  });

  it("orders current-page work before adjacent work", () => {
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

  it("bounds raster DPR and releases canvases", () => {
    expect(rasterDpr(3, 2.5)).toBe(2.5);
    expect(rasterDpr(0.5, 2)).toBe(1);
    expect(rasterDpr(Number.NaN, 2)).toBe(1);
    const canvas = fakeCanvas();
    releaseCanvas(canvas as unknown as HTMLCanvasElement);
    expect([canvas.width, canvas.height]).toEqual([1, 1]);
  });
});

describe("settled page renderer", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubCanvases(): FakeCanvas[] {
    const created: FakeCanvas[] = [];
    vi.stubGlobal("document", { createElement: () => { const canvas = fakeCanvas(); created.push(canvas); return canvas; } });
    return created;
  }

  it("draws the current page first, then adjacent pages, and serves repeats from cache", async () => {
    const surfaces = stubCanvases();
    const { pdf, renders } = fakeDocument();
    const renderer = new SettledPageRenderer();
    const current = fakeCanvas();
    const next = fakeCanvas();
    const settling = renderer.settle(pdf, [spec(2, 1, next), spec(1, 0, current)]);
    await flush();
    renders[0]?.resolve();
    await flush();
    expect(current.hidden).toBe(false);
    expect(next.hidden).toBe(true);
    renders[1]?.resolve();
    await settling;
    expect(next.hidden).toBe(false);

    const again = fakeCanvas();
    await renderer.settle(pdf, [spec(1, 0, again)]);
    expect(renders).toHaveLength(2);
    expect(again.draws).toEqual([surfaces[0]]);
  });

  it("cancels the active job and ignores stale results when a newer settle starts", async () => {
    const surfaces = stubCanvases();
    const { pdf, renders, cancelled } = fakeDocument();
    const renderer = new SettledPageRenderer();
    const stale = fakeCanvas();
    const first = renderer.settle(pdf, [spec(1, 0, stale)]);
    await flush();
    const fresh = fakeCanvas();
    const second = renderer.settle(pdf, [spec(5, 0, fresh)]);
    await first;
    expect(cancelled).toEqual([1]);
    expect(stale.hidden).toBe(true);
    expect(surfaces[0]?.width).toBe(1);
    await flush();
    renders[1]?.resolve();
    await second;
    expect(fresh.hidden).toBe(false);
  });

  it("drops a result that finishes after cancel()", async () => {
    const surfaces = stubCanvases();
    const { pdf, renders } = fakeDocument();
    const renderer = new SettledPageRenderer();
    const target = fakeCanvas();
    const settling = renderer.settle(pdf, [spec(1, 0, target)]);
    await flush();
    const job = renders[0];
    renderer.cancel();
    job?.resolve();
    await settling.catch(() => undefined);
    expect(target.hidden).toBe(true);
    expect(surfaces[0]?.width).toBe(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PdfDocument, PdfRenderJob } from "./doc";
import { StaleGeneration, ThumbnailRenderer, orderThumbnailSpecs, thumbnailCacheKey, thumbnailRasterDpr } from "./thumbs";
import type { ThumbnailRenderSpec } from "./thumbs";

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

const canvas = {} as HTMLCanvasElement;
const spec = (pageNumber: number, priority: number, target: HTMLCanvasElement = canvas): ThumbnailRenderSpec => ({
  pageNumber,
  priority,
  canvas: target,
  cssWidth: 120,
  cssHeight: 180,
  dpr: 1.5
});

function fakeDocument(failPage?: number): { pdf: PdfDocument; rendered: number[] } {
  const rendered: number[] = [];
  const pdf = {
    descriptor: { id: "doc", name: "doc.pdf", byteLength: 1 },
    page: (pageNumber: number) => Promise.resolve({
      size: { width: 100, height: 150 },
      render(target: FakeCanvas, scale: number, dpr: number): PdfRenderJob {
        rendered.push(pageNumber);
        target.width = Math.ceil(100 * scale * dpr);
        target.height = Math.ceil(150 * scale * dpr);
        const promise = pageNumber === failPage ? Promise.reject(new Error("bad page")) : Promise.resolve();
        return { width: 100 * scale, height: 150 * scale, promise, cancel: vi.fn() };
      }
    })
  } as unknown as PdfDocument;
  return { pdf, rendered };
}

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

describe("thumbnail renderer", () => {
  it("renders every requested thumbnail, continues past a failed page, and caches the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const surfaces: FakeCanvas[] = [];
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => {
      const surface = fakeCanvas();
      surfaces.push(surface);
      return surface as unknown as HTMLCanvasElement;
    });
    const { pdf, rendered } = fakeDocument(2);
    const targets = [fakeCanvas(), fakeCanvas(), fakeCanvas()];
    await renderer.settle(pdf, targets.map((target, index) => spec(index + 1, index, target as unknown as HTMLCanvasElement)));
    expect(targets.map((target) => target.hidden)).toEqual([false, true, false]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(surfaces[1]?.width).toBe(1);

    const repeat = fakeCanvas();
    await renderer.settle(pdf, [spec(1, 0, repeat as unknown as HTMLCanvasElement)]);
    expect(rendered).toEqual([1, 2, 3]);
    expect(repeat.draws).toEqual([surfaces[0]]);
    warn.mockRestore();
  });

  it("does not draw thumbnails from a cancelled schedule", async () => {
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => fakeCanvas() as unknown as HTMLCanvasElement);
    const { pdf } = fakeDocument();
    const target = fakeCanvas();
    const settling = renderer.settle(pdf, [spec(1, 0, target as unknown as HTMLCanvasElement)]);
    renderer.cancel();
    await settling;
    expect(target.hidden).toBe(true);
  });
});

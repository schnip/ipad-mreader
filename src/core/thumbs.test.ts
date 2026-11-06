import { describe, expect, it, vi } from "vitest";
import type { PDFWorker } from "pdfjs-dist";
import type { PdfDocument, PdfRenderJob } from "./doc";
import { StaleGeneration, ThumbnailRenderer, orderThumbnailSpecs, thumbnailCacheKey, thumbnailRasterDpr } from "./thumbs";
import type { ThumbnailRenderSpec, ThumbnailRendererOptions } from "./thumbs";

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

function fakeDocument(failPage?: number): { pdf: PdfDocument; rendered: number[]; destroyed: number } {
  const rendered: number[] = [];
  const state = { destroyed: 0 };
  const pdf = {
    descriptor: { id: "doc", name: "doc.pdf", byteLength: 1 },
    destroy: () => {
      state.destroyed += 1;
      return Promise.resolve(undefined);
    },
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
  };
  return { pdf: pdf as unknown as PdfDocument, rendered, get destroyed(): number { return state.destroyed; } };
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

/** Deferrable render jobs for the parallel-pool staleness tests. */
function fakeDeferredDocument(): { pdf: PdfDocument; rendered: number[]; resolvers: Array<() => void>; destroyed: number } {
  const rendered: number[] = [];
  const resolvers: Array<() => void> = [];
  const state = { destroyed: 0 };
  const pdf = {
    descriptor: { id: "doc", name: "doc.pdf", byteLength: 1 },
    destroy: () => {
      state.destroyed += 1;
      return Promise.resolve(undefined);
    },
    page: (pageNumber: number) => Promise.resolve({
      size: { width: 100, height: 150 },
      render(target: FakeCanvas, scale: number, dpr: number): PdfRenderJob {
        rendered.push(pageNumber);
        target.width = Math.ceil(100 * scale * dpr);
        target.height = Math.ceil(150 * scale * dpr);
        let resolveJob: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
          resolveJob = resolve;
        });
        resolvers.push(resolveJob);
        return { width: 100 * scale, height: 150 * scale, promise, cancel: vi.fn() };
      }
    })
  };
  return { pdf: pdf as unknown as PdfDocument, rendered, resolvers, get destroyed(): number { return state.destroyed; } };
}

describe("thumbnail worker pool", () => {
  const poolOptions = (documents: number, opener: ThumbnailRendererOptions["openPoolDocument"]): ThumbnailRendererOptions => ({
    poolDocuments: documents,
    poolMinimumSpecs: 4,
    openPoolDocument: opener,
    createPoolWorker: () => Promise.resolve({ destroy: vi.fn() } as unknown as PDFWorker)
  });
  const bytes = () => Promise.resolve(new Uint8Array(0));

  it("keeps small schedules on the plain serial path", async () => {
    const opener = vi.fn((): Promise<PdfDocument> => Promise.reject(new Error("pool must not start")));
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => fakeCanvas() as unknown as HTMLCanvasElement, poolOptions(2, opener));
    const { pdf, rendered } = fakeDocument();
    const targets = [fakeCanvas(), fakeCanvas()];
    await renderer.settle(pdf, targets.map((target, index) => spec(index + 1, index, target as unknown as HTMLCanvasElement)), bytes);
    expect(rendered).toEqual([1, 2]);
    expect(opener).not.toHaveBeenCalled();
  });

  it("splits large schedules across dedicated documents without duplicates or repeats", async () => {
    const family = [fakeDocument(), fakeDocument()];
    const queue = [...family];
    const opener = vi.fn((): Promise<PdfDocument> => {
      const next = queue.shift();
      return next ? Promise.resolve(next.pdf) : Promise.reject(new Error("test queue exhausted"));
    });
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => fakeCanvas() as unknown as HTMLCanvasElement, poolOptions(2, opener));
    const { pdf } = fakeDocument();
    const targets = [6, 5, 4, 3, 2, 1].map((page, index) => spec(page, index, fakeCanvas() as unknown as HTMLCanvasElement));
    await renderer.settle(pdf, targets, bytes);
    const rendered = family.flatMap(({ rendered: pages }) => pages);
    expect(rendered.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(rendered).size).toEqual(rendered.length);
    expect(family.every(({ rendered: pages }) => pages.length > 0)).toBe(true);
    // The pool is reused for the same document without opening it again.
    const repeat = fakeCanvas();
    await renderer.settle(pdf, [spec(1, 0, repeat as unknown as HTMLCanvasElement)], bytes);
    expect(opener).toHaveBeenCalledTimes(family.length);
    expect(repeat.draws.length).toEqual(1);
  });

  it("drops stale pool results and stops scheduling after cancellation", async () => {
    const deferred = fakeDeferredDocument();
    const eager = fakeDocument();
    const queue: Array<{ pdf: PdfDocument; rendered: number[]; resolvers?: Array<() => void> }> = [deferred, eager];
    const opener = vi.fn((): Promise<PdfDocument> => {
      const next = queue.shift();
      return next ? Promise.resolve(next.pdf) : Promise.reject(new Error("test queue exhausted"));
    });
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => fakeCanvas() as unknown as HTMLCanvasElement, poolOptions(2, opener));
    const targets = [1, 2, 3, 4].map((page, index) => spec(page, index, fakeCanvas() as unknown as HTMLCanvasElement));
    const settling = renderer.settle(deferred.pdf, targets, bytes);
    renderer.cancel();
    deferred.resolvers.forEach((resolve) => resolve());
    await settling;
    expect(targets.every((item) => (item.canvas as unknown as FakeCanvas).hidden)).toBe(true);
    await renderer.releasePool();
    expect(deferred.destroyed).toBeGreaterThan(0);
    expect(eager.destroyed).toBeGreaterThan(0);
  });

  it("renders serially when the pool is disabled", async () => {
    const opener = vi.fn((): Promise<PdfDocument> => Promise.reject(new Error("pool must not start")));
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => fakeCanvas() as unknown as HTMLCanvasElement, {
      poolDocuments: 0,
      poolMinimumSpecs: 1,
      openPoolDocument: opener
    });
    const { pdf, rendered } = fakeDocument();
    const targets = [fakeCanvas(), fakeCanvas()];
    await renderer.settle(pdf, [spec(1, 0, targets[0] as unknown as HTMLCanvasElement), spec(2, 1, targets[1] as unknown as HTMLCanvasElement)], bytes);
    expect(rendered).toEqual([1, 2]);
    expect(targets.filter((target) => target.hidden)).toHaveLength(0);
    expect(opener).not.toHaveBeenCalled();
  });

  it("renders serially when the pool fails to open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opener = vi.fn((): Promise<PdfDocument> => Promise.reject(new Error("no worker")));
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => fakeCanvas() as unknown as HTMLCanvasElement, poolOptions(2, opener));
    const { pdf, rendered } = fakeDocument();
    // Priorities run newest-to-oldest in the grid, so serial order follows.
    const targets = [4, 3, 2, 1].map((page, index) => spec(page, index, fakeCanvas() as unknown as HTMLCanvasElement));
    await renderer.settle(pdf, targets, bytes);
    expect(rendered).toEqual([4, 3, 2, 1]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("persistent thumbnail cache", () => {
  interface FakeBitmap extends ImageBitmap {
    close: () => void;
  }
  const createBitmap = (): FakeBitmap & { closes: number } => {
    const fake = { width: 180, height: 270, closes: 0, close(): void {
      fake.closes += 1;
    } };
    return fake as unknown as FakeBitmap & { closes: number };
  };

  it("draws stored rasters without invoking the pdf and without re-storing", async () => {
    const stored = createBitmap();
    const store = {
      get: vi.fn((): Promise<Blob> => Promise.resolve(new Blob())),
      put: vi.fn()
    };
    const decode = vi.fn((): Promise<ImageBitmap> => Promise.resolve(stored));
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => fakeCanvas() as unknown as HTMLCanvasElement, { store, decodeImage: decode });
    const { pdf } = fakeDocument();
    const target = fakeCanvas();
    await renderer.settle(pdf, [spec(1, 0, target as unknown as HTMLCanvasElement)]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(stored.closes).toEqual(1);
    expect(target.draws).toHaveLength(1);
    expect(store.put).not.toHaveBeenCalled();
    // The raster enters the memory cache, so a repeat hit skips both the pdf
    // and the decode.
    const repeat = fakeCanvas();
    await renderer.settle(pdf, [spec(1, 0, repeat as unknown as HTMLCanvasElement)]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(repeat.draws).toHaveLength(1);
  });

  it("renders, stores, and falls back to rendering when stored decoding fails", async () => {
    const get = vi.fn((key: string): Promise<Blob | undefined> => {
      return key.includes(":3:") ? Promise.resolve(new Blob()) : Promise.resolve(undefined);
    });
    const puts: Array<[string, HTMLCanvasElement]> = [];
    const put = vi.fn((key: string, canvas: HTMLCanvasElement): void => {
      puts.push([key, canvas]);
    });
    const decode = vi.fn((): Promise<ImageBitmap> => Promise.reject(new Error("decode failed")));
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => fakeCanvas() as unknown as HTMLCanvasElement, { store: { get, put }, decodeImage: decode, persistMinimumMs: 0 });
    const { pdf, rendered } = fakeDocument();
    const targets = [1, 2, 3].map((page, index) => spec(page, index, fakeCanvas() as unknown as HTMLCanvasElement));
    await renderer.settle(pdf, targets);
    expect(rendered).toEqual([1, 2, 3]);
    expect(puts.map(([key]) => key)).toEqual(
      targets.map((item) => thumbnailCacheKey("doc", item))
    );
    expect(puts).toHaveLength(3);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("persists only measured-slow renders and always keeps cheap ones in memory", async () => {
    const puts: string[] = [];
    const store = {
      get: vi.fn((): Promise<Blob | undefined> => Promise.resolve(undefined)),
      put: (key: string): void => {
        puts.push(key);
      }
    };
    const renderer = new ThumbnailRenderer(8, 1024 * 1024, () => fakeCanvas() as unknown as HTMLCanvasElement, {
      store,
      persistMinimumMs: Number.POSITIVE_INFINITY
    });
    const { pdf, rendered } = fakeDocument();
    const targets = [2, 1].map((page, index) => spec(page, index, fakeCanvas() as unknown as HTMLCanvasElement));
    await renderer.settle(pdf, targets);
    expect(rendered).toEqual([2, 1]);
    expect(puts).toEqual([]);
    // Both stay in the in-memory LRU, so a repeat equals a cache hit.
    const repeat = fakeCanvas();
    await renderer.settle(pdf, [spec(1, 0, repeat as unknown as HTMLCanvasElement)]);
    expect(rendered).toEqual([2, 1]);
    expect(repeat.draws).toHaveLength(1);
  });
});

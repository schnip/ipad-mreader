import type { PdfDocument, PdfRenderJob } from "./doc";
import { isRenderingCancelled } from "./math";

export interface PageRenderSpec {
  pageNumber: number;
  canvas: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  pdfScale: number;
  dpr: number;
  priority: number;
}

interface CachedSurface {
  canvas: HTMLCanvasElement;
  bytes: number;
}

export const MAX_RENDER_DIMENSION = 8192;
export const MAX_RENDER_PIXELS = 16 * 1024 * 1024;

export function boundedRasterMultiplier(
  cssWidth: number,
  cssHeight: number,
  zoom: number,
  dpr: number,
  maximumDimension = MAX_RENDER_DIMENSION,
  maximumPixels = MAX_RENDER_PIXELS
): number {
  const width = Math.max(1, cssWidth * Math.max(1, zoom) * Math.max(1, dpr));
  const height = Math.max(1, cssHeight * Math.max(1, zoom) * Math.max(1, dpr));
  const dimensionLimit = Math.max(1, maximumDimension) / Math.max(width, height);
  const areaLimit = Math.sqrt(Math.max(1, maximumPixels) / (width * height));
  return Math.min(1, dimensionLimit, areaLimit);
}

export class WeightedLruCache<Key, Value> {
  private readonly entries = new Map<Key, { value: Value; weight: number }>();
  private totalWeight = 0;

  constructor(
    readonly maximumEntries: number,
    readonly maximumWeight: number,
    private readonly dispose?: (value: Value) => void
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get weight(): number {
    return this.totalWeight;
  }

  get(key: Key): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Stores `value`, evicting least-recently-used entries over budget. A value
   * that can never fit is rejected and leaves the cache, including any
   * existing entry for `key`, unchanged; the caller still owns it.
   */
  set(key: Key, value: Value, weight: number): boolean {
    const boundedWeight = Math.max(0, Number.isFinite(weight) ? weight : 0);
    if (this.maximumEntries <= 0 || boundedWeight > this.maximumWeight) return false;
    const existing = this.entries.get(key);
    if (existing) {
      this.totalWeight -= existing.weight;
      this.entries.delete(key);
      if (existing.value !== value) this.dispose?.(existing.value);
    }
    this.entries.set(key, { value, weight: boundedWeight });
    this.totalWeight += boundedWeight;
    this.trim();
    return true;
  }

  clear(): void {
    for (const entry of this.entries.values()) this.dispose?.(entry.value);
    this.entries.clear();
    this.totalWeight = 0;
  }

  private trim(): void {
    while (this.entries.size > this.maximumEntries || this.totalWeight > this.maximumWeight) {
      const oldest = this.entries.entries().next().value as [Key, { value: Value; weight: number }] | undefined;
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      this.totalWeight -= oldest[1].weight;
      this.dispose?.(oldest[1].value);
    }
  }
}

export function orderRenderSpecs(specs: readonly PageRenderSpec[]): PageRenderSpec[] {
  return [...specs].sort((a, b) => a.priority - b.priority || a.pageNumber - b.pageNumber);
}

export function renderCacheKey(documentId: string, spec: Pick<PageRenderSpec, "pageNumber" | "pdfScale" | "dpr">): string {
  return `${documentId}:${spec.pageNumber}:${Math.round(spec.pdfScale * 1000)}:${Math.round(spec.dpr * 100)}`;
}

export class SettledPageRenderer {
  private readonly cache: WeightedLruCache<string, CachedSurface>;
  private generation = 0;
  private activeJob?: PdfRenderJob;

  constructor(maximumEntries = 7, maximumBytes = 96 * 1024 * 1024) {
    this.cache = new WeightedLruCache(maximumEntries, maximumBytes, (surface) => releaseCanvas(surface.canvas));
  }

  async settle(pdf: PdfDocument, specs: readonly PageRenderSpec[]): Promise<void> {
    const generation = ++this.generation;
    this.activeJob?.cancel();
    this.activeJob = undefined;
    const ordered = orderRenderSpecs(specs);
    const first = ordered[0];
    if (!first) return;
    await this.renderOne(pdf, first, generation);
    await this.renderRemaining(pdf, ordered.slice(1), generation);
  }

  cancel(): void {
    this.generation += 1;
    this.activeJob?.cancel();
    this.activeJob = undefined;
  }

  clear(): void {
    this.cancel();
    this.cache.clear();
  }

  private async renderRemaining(pdf: PdfDocument, specs: readonly PageRenderSpec[], generation: number): Promise<void> {
    for (const spec of specs) {
      if (generation !== this.generation) return;
      try {
        await this.renderOne(pdf, spec, generation);
      } catch (error) {
        if (!isRenderingCancelled(error) && generation === this.generation) console.error("Adjacent page render failed", error);
      }
    }
  }

  private async renderOne(pdf: PdfDocument, spec: PageRenderSpec, generation: number): Promise<void> {
    const key = renderCacheKey(pdf.descriptor.id, spec);
    const cached = this.cache.get(key);
    if (cached) {
      if (generation === this.generation) drawSurface(cached.canvas, spec);
      return;
    }
    const page = await pdf.page(spec.pageNumber);
    if (generation !== this.generation) return;
    const surface = document.createElement("canvas");
    const job = page.render(surface, spec.pdfScale, spec.dpr);
    this.activeJob = job;
    try {
      await job.promise;
    } catch (error) {
      releaseCanvas(surface);
      if (isRenderingCancelled(error)) return;
      throw error;
    } finally {
      if (this.activeJob === job) this.activeJob = undefined;
    }
    if (generation !== this.generation) {
      releaseCanvas(surface);
      return;
    }
    drawSurface(surface, spec);
    const bytes = surface.width * surface.height * 4;
    if (!this.cache.set(key, { canvas: surface, bytes }, bytes)) releaseCanvas(surface);
  }
}

/** Shrinks a canvas's backing store so WebKit can reclaim it before GC. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 1;
  canvas.height = 1;
}

/** Device-pixel ratio for a raster, at least 1 and at most `cap`. */
export function rasterDpr(devicePixelRatio: number, cap: number): number {
  return Math.min(Math.max(Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1, 1), cap);
}

function drawSurface(surface: HTMLCanvasElement, spec: PageRenderSpec): void {
  spec.canvas.width = surface.width;
  spec.canvas.height = surface.height;
  spec.canvas.style.width = `${spec.cssWidth}px`;
  spec.canvas.style.height = `${spec.cssHeight}px`;
  const context = spec.canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("A 2D canvas context is required to display a PDF page.");
  context.drawImage(surface, 0, 0);
  spec.canvas.hidden = false;
}

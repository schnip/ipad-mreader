import type { PdfDocument, PdfRenderJob } from "./doc";
import { isRenderingCancelled } from "./math";
import { WeightedLruCache, releaseCanvas } from "./render";

export interface ThumbnailRenderSpec {
  pageNumber: number;
  canvas: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  priority: number;
}

export class StaleGeneration {
  private value = 0;

  next(): number {
    this.value += 1;
    return this.value;
  }

  isCurrent(generation: number): boolean {
    return generation === this.value;
  }
}

export function thumbnailCacheKey(documentId: string, spec: Pick<ThumbnailRenderSpec, "pageNumber" | "cssWidth" | "cssHeight" | "dpr">): string {
  const dpr = thumbnailRasterDpr(spec.dpr);
  return `${documentId}:${spec.pageNumber}:${Math.round(spec.cssWidth * dpr)}x${Math.round(spec.cssHeight * dpr)}`;
}

export function orderThumbnailSpecs(specs: readonly ThumbnailRenderSpec[]): ThumbnailRenderSpec[] {
  return [...specs].sort((a, b) => a.priority - b.priority || a.pageNumber - b.pageNumber);
}

/**
 * Thumbnail rasters are deliberately capped at 1.5x: small thumbnails gain
 * little visible sharpness beyond that, and the cap keeps 128 cached
 * thumbnails inside the 32 MiB budget.
 */
export function thumbnailRasterDpr(dpr: number): number {
  return Math.min(Math.max(0.5, Number.isFinite(dpr) ? dpr : 1), 1.5);
}

/**
 * Renders thumbnails one at a time in priority order. pdf.js already parses
 * and interprets pages in its own worker, so the rendered canvas is cached
 * directly and copied into the mounted thumbnail canvas.
 */
export class ThumbnailRenderer {
  private readonly cache: WeightedLruCache<string, HTMLCanvasElement>;
  private readonly generations = new StaleGeneration();
  private activeJob?: PdfRenderJob;

  constructor(maximumEntries = 128, maximumBytes = 32 * 1024 * 1024, private readonly createCanvas = () => document.createElement("canvas")) {
    this.cache = new WeightedLruCache(maximumEntries, maximumBytes, releaseCanvas);
  }

  async settle(pdf: PdfDocument, specs: readonly ThumbnailRenderSpec[]): Promise<void> {
    const generation = this.generations.next();
    this.activeJob?.cancel();
    this.activeJob = undefined;
    for (const spec of orderThumbnailSpecs(specs)) {
      if (!this.generations.isCurrent(generation)) return;
      try {
        await this.renderOne(pdf, spec, generation);
      } catch (error) {
        if (!isRenderingCancelled(error) && this.generations.isCurrent(generation)) {
          console.warn(`Thumbnail ${spec.pageNumber} could not be rendered`, error);
        }
      }
    }
  }

  cancel(): void {
    this.generations.next();
    this.activeJob?.cancel();
    this.activeJob = undefined;
  }

  clear(): void {
    this.cancel();
    this.cache.clear();
  }

  private async renderOne(pdf: PdfDocument, spec: ThumbnailRenderSpec, generation: number): Promise<void> {
    const key = thumbnailCacheKey(pdf.descriptor.id, spec);
    const cached = this.cache.get(key);
    if (cached) {
      if (this.generations.isCurrent(generation)) drawThumbnail(cached, spec);
      return;
    }
    const page = await pdf.page(spec.pageNumber);
    if (!this.generations.isCurrent(generation)) return;
    const dpr = thumbnailRasterDpr(spec.dpr);
    const canvas = this.createCanvas();
    const scale = Math.min(spec.cssWidth / page.size.width, spec.cssHeight / page.size.height);
    const job = page.render(canvas, scale, dpr);
    this.activeJob = job;
    try {
      await job.promise;
    } catch (error) {
      releaseCanvas(canvas);
      throw error;
    } finally {
      if (this.activeJob === job) this.activeJob = undefined;
    }
    if (!this.generations.isCurrent(generation)) {
      releaseCanvas(canvas);
      return;
    }
    drawThumbnail(canvas, spec);
    if (!this.cache.set(key, canvas, canvas.width * canvas.height * 4)) releaseCanvas(canvas);
  }
}

function drawThumbnail(source: HTMLCanvasElement, spec: ThumbnailRenderSpec): void {
  spec.canvas.width = source.width;
  spec.canvas.height = source.height;
  spec.canvas.style.width = `${spec.cssWidth}px`;
  spec.canvas.style.height = `${spec.cssHeight}px`;
  const context = spec.canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("A 2D canvas context is required to display a thumbnail.");
  context.drawImage(source, 0, 0);
  spec.canvas.hidden = false;
}

import type { PdfDocument, PdfRenderJob } from "./doc";
import { WeightedLruCache } from "./render";

export interface ThumbnailRenderSpec {
  pageNumber: number;
  canvas: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  priority: number;
}

interface ThumbnailSurface {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

interface WorkerPending {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
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
  return `${documentId}:${spec.pageNumber}:${Math.round(spec.cssWidth * spec.dpr)}x${Math.round(spec.cssHeight * spec.dpr)}`;
}

export function orderThumbnailSpecs(specs: readonly ThumbnailRenderSpec[]): ThumbnailRenderSpec[] {
  return [...specs].sort((a, b) => a.priority - b.priority || a.pageNumber - b.pageNumber);
}

export class ThumbnailRenderer {
  private readonly cache: WeightedLruCache<string, ThumbnailSurface>;
  private readonly generations = new StaleGeneration();
  private activeJob?: PdfRenderJob;
  private processor?: ThumbnailWorkerProcessor;

  constructor(maximumEntries = 64, maximumBytes = 32 * 1024 * 1024) {
    this.cache = new WeightedLruCache(maximumEntries, maximumBytes, (surface) => surface.close?.());
    this.processor = ThumbnailWorkerProcessor.create();
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
    this.processor?.destroy();
    this.processor = undefined;
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
    const dpr = Math.min(Math.max(1, spec.dpr), 1.5);
    const canvas = document.createElement("canvas");
    const scale = Math.min(spec.cssWidth / page.size.width, spec.cssHeight / page.size.height);
    const job = page.render(canvas, scale, dpr);
    this.activeJob = job;
    try {
      await job.promise;
    } finally {
      if (this.activeJob === job) this.activeJob = undefined;
    }
    if (!this.generations.isCurrent(generation)) return;
    const surface = await this.process(canvas);
    if (!this.generations.isCurrent(generation)) {
      surface.close?.();
      return;
    }
    drawThumbnail(surface, spec);
    this.cache.set(key, surface, surface.width * surface.height * 4);
  }

  private async process(canvas: HTMLCanvasElement): Promise<ThumbnailSurface> {
    if (!this.processor) return canvasSurface(canvas);
    try {
      const bitmap = await this.processor.process(canvas);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      this.processor.destroy();
      this.processor = undefined;
      return canvasSurface(canvas);
    }
  }
}

class ThumbnailWorkerProcessor {
  private sequence = 0;
  private readonly pending = new Map<number, WorkerPending>();

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<{ type: "result" | "error"; id: number; bitmap?: ImageBitmap; message?: string }>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) {
        event.data.bitmap?.close();
        return;
      }
      this.pending.delete(event.data.id);
      if (event.data.type === "result" && event.data.bitmap) pending.resolve(event.data.bitmap);
      else pending.reject(new Error(event.data.message ?? "Thumbnail worker failed."));
    };
    worker.onerror = () => this.failAll(new Error("Thumbnail worker is unavailable."));
  }

  static create(): ThumbnailWorkerProcessor | undefined {
    if (!("Worker" in globalThis) || !("OffscreenCanvas" in globalThis) || !("createImageBitmap" in globalThis)) return undefined;
    try {
      return new ThumbnailWorkerProcessor(new Worker(new URL("./thumb.worker.ts", import.meta.url), { type: "module" }));
    } catch {
      return undefined;
    }
  }

  async process(canvas: HTMLCanvasElement): Promise<ImageBitmap> {
    const bitmap = await createImageBitmap(canvas);
    const id = ++this.sequence;
    return new Promise<ImageBitmap>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ type: "process", id, bitmap, width: canvas.width, height: canvas.height }, [bitmap]);
      } catch (error) {
        this.pending.delete(id);
        bitmap.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  destroy(): void {
    this.failAll(new Error("Thumbnail worker was stopped."));
    this.worker.postMessage({ type: "destroy" });
    this.worker.terminate();
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function canvasSurface(canvas: HTMLCanvasElement): ThumbnailSurface {
  return {
    source: canvas,
    width: canvas.width,
    height: canvas.height,
    close: () => {
      canvas.width = 1;
      canvas.height = 1;
    }
  };
}

function drawThumbnail(surface: ThumbnailSurface, spec: ThumbnailRenderSpec): void {
  spec.canvas.width = surface.width;
  spec.canvas.height = surface.height;
  spec.canvas.style.width = `${spec.cssWidth}px`;
  spec.canvas.style.height = `${spec.cssHeight}px`;
  const context = spec.canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("A 2D canvas context is required to display a thumbnail.");
  context.drawImage(surface.source, 0, 0);
  spec.canvas.hidden = false;
}

function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

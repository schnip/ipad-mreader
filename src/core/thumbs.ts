import type { PDFWorker } from "pdfjs-dist";
import type { PdfDescriptor, PdfDocument as PdfDocumentInstance, PdfRenderJob } from "./doc";
import { isRenderingCancelled } from "./math";
import { WeightedLruCache, releaseCanvas } from "./render";
import { createThumbnailStore } from "./thumbcache";
import type { ThumbnailStore } from "./thumbcache";
import { ThumbnailWorkerPool } from "./thumbpool";

export interface ThumbnailRenderSpec {
  pageNumber: number;
  canvas: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  priority: number;
}

export type ThumbnailSource = HTMLCanvasElement | ImageBitmap;

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

/** Dedicated thumbnail workers; 0 disables the parallel pool entirely. */
export const THUMBNAIL_POOL_DOCUMENTS_CAP = 3;
/** Scanned-image decode is only worth extra workers once the batch is sizable. */
export const THUMBNAIL_POOL_MINIMUM_SPECS = 6;
/**
 * Fresh renders slower than this are worth keeping on disk; cheaper ones cost
 * little to re-render and are skipped when the persistent cache is written.
 */
export const THUMBNAIL_PERSIST_MINIMUM_MS = 100;

/**
 * Default pool size: leave the app some headroom (rasterization itself runs on
 * the main thread) but scale with the actual device core count, capped.
 */
export function defaultPoolDocuments(): number {
  if (typeof navigator === "undefined" || !Number.isFinite(navigator.hardwareConcurrency)) {
    return Math.min(2, THUMBNAIL_POOL_DOCUMENTS_CAP);
  }
  return Math.min(THUMBNAIL_POOL_DOCUMENTS_CAP, Math.max(1, Math.floor(navigator.hardwareConcurrency) - 2));
}

export type ImageDecoder = (blob: Blob) => Promise<ImageBitmap>;

export type PoolDocumentOpener = (
  bytes: Uint8Array,
  descriptor: PdfDescriptor,
  worker: PDFWorker
) => Promise<PdfDocumentInstance>;

type PdfWorkerInstance = PDFWorker;

async function defaultCreatePoolWorker(): Promise<PdfWorkerInstance> {
  // Loaded lazily so test environments never load pdf.js through this module.
  const { PDFWorker } = await import("pdfjs-dist");
  return new PDFWorker();
}

async function defaultOpenPoolDocument(bytes: Uint8Array, descriptor: PdfDescriptor, worker: PDFWorker): Promise<PdfDocumentInstance> {
  const { PdfDocument } = await import("./doc");
  return PdfDocument.open(bytes, descriptor, worker);
}

function defaultDecodeImage(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") throw new Error("Bitmap decoding is unavailable in this browser.");
  return createImageBitmap(blob);
}

// Computed once: in environments without IndexedDB this stays undefined and
// the renderer simply skips the persistent layer.
const defaultStore = createThumbnailStore();

export interface ThumbnailRendererOptions {
  store?: ThumbnailStore;
  decodeImage?: ImageDecoder;
  poolDocuments?: number;
  poolMinimumSpecs?: number;
  openPoolDocument?: PoolDocumentOpener;
  createPoolWorker?: () => Promise<PdfWorkerInstance>;
  /** Fresh renders at least this slow are persisted; lower to 0 to persist all. */
  persistMinimumMs?: number;
}

/**
 * Renders thumbnails in priority order, reusing rasters on disk when a
 * document's grid is reopened. When the schedule is large enough, dedicated
 * pdf.js documents render other pages in parallel; each pool document decodes
 * inside its own worker so heavy scanned pages don't serialize behind the
 * reading document's worker.
 */
export class ThumbnailRenderer {
  private readonly cache: WeightedLruCache<string, HTMLCanvasElement>;
  private readonly generations = new StaleGeneration();
  private readonly activeJobs = new Set<PdfRenderJob>();
  private pool?: ThumbnailWorkerPool;
  private poolDescriptorId?: string;
  private poolFailed = false;

  constructor(
    maximumEntries = 128,
    maximumBytes = 32 * 1024 * 1024,
    private readonly createCanvas = () => document.createElement("canvas"),
    private readonly options: ThumbnailRendererOptions = {}
  ) {
    this.cache = new WeightedLruCache(maximumEntries, maximumBytes, releaseCanvas);
  }

  async settle(pdf: PdfDocumentInstance, specs: readonly ThumbnailRenderSpec[], readBytes?: () => Promise<Uint8Array>): Promise<void> {
    const generation = this.generations.next();
    this.cancelActive();
    const ordered = orderThumbnailSpecs(specs);
    if (ordered.length === 0) return;
    const minimumSpecs = this.options.poolMinimumSpecs ?? THUMBNAIL_POOL_MINIMUM_SPECS;
    const pool = readBytes && ordered.length >= minimumSpecs && !this.poolFailed
      ? this.poolFor(pdf.descriptor, readBytes)
      : undefined;
    if (pool && await this.poolReady(pool)) {
      const isCurrent = () => this.generations.isCurrent(generation);
      await pool.settle(ordered, (source, task) => this.renderOne(source, task, generation), isCurrent);
      return;
    }
    for (const spec of ordered) {
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
    this.cancelActive();
  }

  clear(): void {
    this.cancel();
    this.cache.clear();
  }

  /** Tears down any dedicated thumbnail workers; safe to call repeatedly. */
  async releasePool(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    this.poolDescriptorId = undefined;
    this.poolFailed = false;
    await pool?.destroy().catch(() => undefined);
  }

  private cancelActive(): void {
    for (const job of this.activeJobs) job.cancel();
    this.activeJobs.clear();
  }

  private poolFor(descriptor: PdfDescriptor, readBytes: () => Promise<Uint8Array>): ThumbnailWorkerPool | undefined {
    const size = this.options.poolDocuments ?? defaultPoolDocuments();
    if (size < 1) return undefined;
    if (this.pool && this.poolDescriptorId === descriptor.id) return this.pool;
    void this.releasePool();
    this.pool = new ThumbnailWorkerPool({
      size,
      descriptor,
      readBytes,
      openDocument: this.options.openPoolDocument ?? defaultOpenPoolDocument,
      createWorker: this.options.createPoolWorker ?? defaultCreatePoolWorker
    });
    this.poolDescriptorId = descriptor.id;
    return this.pool;
  }

  private async poolReady(pool: ThumbnailWorkerPool): Promise<boolean> {
    try {
      const ready = await pool.ensure();
      if (!ready) {
        this.poolFailed = true;
        await this.releasePool();
      }
      return ready;
    } catch (error) {
      console.warn("Thumbnail pool could not start; falling back to the shared worker", error);
      this.poolFailed = true;
      await this.releasePool().catch(() => undefined);
      return false;
    }
  }

  private async renderOne(pdf: PdfDocumentInstance, spec: ThumbnailRenderSpec, generation: number): Promise<void> {
    const key = thumbnailCacheKey(pdf.descriptor.id, spec);
    const cached = this.cache.get(key);
    if (cached) {
      if (this.generations.isCurrent(generation)) drawThumbnail(cached, spec);
      return;
    }
    const stored = this.store ? await this.readStoredThumbnail(key) : undefined;
    if (stored) {
      if (this.generations.isCurrent(generation)) this.drawStoredThumbnail(key, stored, spec);
      return;
    }
    const started = performance.now();
    const page = await pdf.page(spec.pageNumber);
    if (!this.generations.isCurrent(generation)) return;
    const dpr = thumbnailRasterDpr(spec.dpr);
    const canvas = this.createCanvas();
    const scale = Math.min(spec.cssWidth / page.size.width, spec.cssHeight / page.size.height);
    const job = page.render(canvas, scale, dpr);
    this.activeJobs.add(job);
    try {
      await job.promise;
    } catch (error) {
      releaseCanvas(canvas);
      throw error;
    } finally {
      this.activeJobs.delete(job);
    }
    if (!this.generations.isCurrent(generation)) {
      releaseCanvas(canvas);
      return;
    }
    drawThumbnail(canvas, spec);
    if (!this.cache.set(key, canvas, canvas.width * canvas.height * 4)) {
      releaseCanvas(canvas);
    }
    // `toBlob` snapshots the canvas synchronously, so a later LRU eviction can
    // no longer blank the encoded raster. Persisting only measured-slow renders
    // keeps cheap documents from filling the disk cache.
    if (performance.now() - started >= this.persistMinimumMs) this.store?.put(key, canvas);
  }

  private async readStoredThumbnail(key: string): Promise<ImageBitmap | undefined> {
    if (!this.store) return undefined;
    try {
      const blob = await this.store.get(key);
      if (!blob) return undefined;
      return await this.decode(blob);
    } catch {
      return undefined;
    }
  }

  private get store(): ThumbnailStore | undefined {
    return this.options.store ?? defaultStore;
  }

  private get persistMinimumMs(): number {
    return this.options.persistMinimumMs ?? THUMBNAIL_PERSIST_MINIMUM_MS;
  }

  private get decode(): ImageDecoder {
    return this.options.decodeImage ?? defaultDecodeImage;
  }

  private drawStoredThumbnail(key: string, bitmap: ImageBitmap, spec: ThumbnailRenderSpec): void {
    const raster = this.createCanvas();
    raster.width = bitmap.width;
    raster.height = bitmap.height;
    const context = raster.getContext("2d", { alpha: false });
    if (!context) {
      bitmap.close();
      throw new Error("A 2D canvas context is required to display a thumbnail.");
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    if (this.cache.set(key, raster, raster.width * raster.height * 4)) {
      drawThumbnail(raster, spec);
    } else {
      drawThumbnail(raster, spec);
      releaseCanvas(raster);
    }
  }
}

function drawThumbnail(source: ThumbnailSource, spec: ThumbnailRenderSpec): void {
  spec.canvas.width = source.width;
  spec.canvas.height = source.height;
  spec.canvas.style.width = `${spec.cssWidth}px`;
  spec.canvas.style.height = `${spec.cssHeight}px`;
  const context = spec.canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("A 2D canvas context is required to display a thumbnail.");
  context.drawImage(source, 0, 0);
  spec.canvas.hidden = false;
}

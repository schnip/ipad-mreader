import { GlobalWorkerOptions, Util, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfInfo {
  name: string;
  bytes: number;
  pages: number;
  loadMs: number;
}

export interface PdfBenchmark {
  pages: number;
  totalMs: number;
  averageMs: number;
  p95Ms: number;
  longestMs: number;
  jsHeapBytes?: number;
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  hasEOL: boolean;
}

interface PerformanceWithMemory extends Performance {
  memory?: { usedJSHeapSize: number };
}

interface PrefetchedPage {
  pageNumber: number;
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  scale: number;
  dpr: number;
  containerWidth: number;
  containerHeight: number;
}

export class PdfProbe {
  private document?: PDFDocumentProxy;
  private page = 1;
  private renderTask?: RenderTask;
  private renderGeneration = 0;
  private prefetchGeneration = 0;
  private readonly prefetched = new Map<number, PrefetchedPage>();
  private viewportScale = 1;

  constructor(
    private readonly host: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly inkCanvas: HTMLCanvasElement,
    private readonly textLayer: HTMLElement,
    private readonly previousPageCanvas: HTMLCanvasElement,
    private readonly nextPageCanvas: HTMLCanvasElement
  ) {}

  get pageNumber(): number {
    return this.page;
  }

  get pageCount(): number {
    return this.document?.numPages ?? 0;
  }

  async open(file: File): Promise<PdfInfo> {
    this.renderTask?.cancel();
    this.prefetchGeneration += 1;
    this.prefetched.clear();
    this.syncAdjacentPreviews();
    await this.document?.destroy();
    const start = performance.now();
    this.document = await getDocument({ data: await file.arrayBuffer() }).promise;
    this.page = 1;
    await this.render();
    return { name: file.name, bytes: file.size, pages: this.document.numPages, loadMs: performance.now() - start };
  }

  async turn(direction: -1 | 1): Promise<boolean> {
    if (!this.document) return false;
    const next = Math.min(this.document.numPages, Math.max(1, this.page + direction));
    if (next === this.page) return false;
    this.page = next;
    const cached = this.prefetched.get(next);
    if (cached && this.cacheFits(cached)) {
      const generation = ++this.renderGeneration;
      this.prefetchGeneration += 1;
      this.renderTask?.cancel();
      this.showPrefetched(cached);
      void this.completePrefetchedTurn(cached, generation).catch(() => {
        if (generation === this.renderGeneration) void this.render();
      });
      return true;
    }
    await this.render();
    return true;
  }

  async render(): Promise<void> {
    if (!this.document) return;
    const generation = ++this.renderGeneration;
    this.prefetchGeneration += 1;
    this.renderTask?.cancel();
    const page = await this.document.getPage(this.page);
    if (generation !== this.renderGeneration) return;
    const viewport = this.fitViewport(page);
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.sizeVisibleCanvases(viewport.width, viewport.height, viewport.scale, dpr);
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D canvas is unavailable");
    this.renderTask = page.render({
      canvas: this.canvas,
      canvasContext: context,
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0]
    });
    try {
      await this.renderTask.promise;
    } catch (error) {
      if (error instanceof Error && error.name === "RenderingCancelledException") return;
      throw error;
    }
    if (generation === this.renderGeneration) {
      await this.renderTextLayer(page, generation);
      this.queueAdjacentPrefetch();
    }
  }

  async benchmarkAll(onProgress: (completed: number, total: number) => void): Promise<PdfBenchmark> {
    if (!this.document) throw new Error("Open a PDF first");
    const scratch = document.createElement("canvas");
    const context = scratch.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D canvas is unavailable");
    const durations: number[] = [];
    const totalStart = performance.now();
    for (let pageNumber = 1; pageNumber <= this.document.numPages; pageNumber += 1) {
      const started = performance.now();
      const page = await this.document.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(1, 900 / base.width);
      const viewport = page.getViewport({ scale });
      scratch.width = Math.ceil(viewport.width);
      scratch.height = Math.ceil(viewport.height);
      await page.render({ canvas: scratch, canvasContext: context, viewport }).promise;
      page.cleanup();
      durations.push(performance.now() - started);
      onProgress(pageNumber, this.document.numPages);
      if (pageNumber % 10 === 0) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    return {
      pages: durations.length,
      totalMs: performance.now() - totalStart,
      averageMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
      p95Ms: sorted[p95Index] ?? 0,
      longestMs: sorted.at(-1) ?? 0,
      jsHeapBytes: (performance as PerformanceWithMemory).memory?.usedJSHeapSize
    };
  }

  private fitViewport(page: PDFPageProxy) {
    const base = page.getViewport({ scale: 1 });
    const { width, height } = this.containerSize();
    const scale = Math.min((width - 32) / base.width, (height - 32) / base.height);
    return page.getViewport({ scale });
  }

  private async renderTextLayer(page: PDFPageProxy, generation: number): Promise<void> {
    const text = await page.getTextContent();
    if (generation !== this.renderGeneration) return;
    const viewport = page.getViewport({ scale: this.viewportScale });
    this.textLayer.replaceChildren();
    for (const item of text.items) {
      if (!("str" in item) || item.str.length === 0) continue;
      const typed = item as PdfTextItem;
      const transform = Util.transform(viewport.transform, typed.transform);
      const fontHeight = Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
      const angle = Math.atan2(transform[1] ?? 0, transform[0] ?? 1);
      const span = document.createElement("span");
      span.className = "text-item";
      span.dataset.index = String(this.textLayer.childElementCount);
      span.dataset.length = String(typed.str.length);
      span.textContent = typed.str;
      span.style.left = `${transform[4] ?? 0}px`;
      span.style.top = `${(transform[5] ?? 0) - fontHeight}px`;
      span.style.width = `${Math.max(2, typed.width * this.viewportScale)}px`;
      span.style.height = `${Math.max(2, fontHeight)}px`;
      span.style.fontSize = `${fontHeight}px`;
      span.style.transform = `rotate(${angle}rad)`;
      span.style.transformOrigin = "0 100%";
      span.setAttribute("aria-label", typed.str);
      this.textLayer.append(span);
      if (typed.hasEOL) span.dataset.eol = "true";
    }
  }

  private sizeVisibleCanvases(cssWidth: number, cssHeight: number, scale: number, dpr: number): void {
    this.viewportScale = scale;
    this.canvas.width = Math.ceil(cssWidth * dpr);
    this.canvas.height = Math.ceil(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.inkCanvas.width = this.canvas.width;
    this.inkCanvas.height = this.canvas.height;
    this.inkCanvas.style.width = this.canvas.style.width;
    this.inkCanvas.style.height = this.canvas.style.height;
    this.host.style.width = this.canvas.style.width;
    this.host.style.height = this.canvas.style.height;
    this.syncAdjacentPreviews();
  }

  private showPrefetched(cached: PrefetchedPage): void {
    this.sizeVisibleCanvases(cached.cssWidth, cached.cssHeight, cached.scale, cached.dpr);
    this.textLayer.replaceChildren();
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D canvas is unavailable");
    context.drawImage(cached.canvas, 0, 0);
  }

  private async completePrefetchedTurn(cached: PrefetchedPage, generation: number): Promise<void> {
    await this.renderTextLayer(cached.page, generation);
    if (generation === this.renderGeneration) this.queueAdjacentPrefetch();
  }

  private queueAdjacentPrefetch(): void {
    const generation = ++this.prefetchGeneration;
    window.setTimeout(() => {
      void this.prefetchAdjacent(generation).catch(() => undefined);
    }, 0);
  }

  private async prefetchAdjacent(generation: number): Promise<void> {
    const pdfDocument = this.document;
    if (!pdfDocument) return;
    const adjacent = [this.page - 1, this.page + 1].filter((pageNumber) => pageNumber >= 1 && pageNumber <= pdfDocument.numPages);
    const wanted = new Set(adjacent);
    for (const pageNumber of this.prefetched.keys()) {
      if (!wanted.has(pageNumber)) this.prefetched.delete(pageNumber);
    }
    for (const pageNumber of adjacent) {
      if (generation !== this.prefetchGeneration || pdfDocument !== this.document) return;
      if (this.prefetched.has(pageNumber)) continue;
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = this.fitViewport(page);
      const dpr = Math.min(window.devicePixelRatio, 2);
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0]
      }).promise;
      if (generation !== this.prefetchGeneration || pdfDocument !== this.document) return;
      const container = this.containerSize();
      this.prefetched.set(pageNumber, {
        pageNumber,
        page,
        canvas,
        cssWidth: viewport.width,
        cssHeight: viewport.height,
        scale: viewport.scale,
        dpr,
        containerWidth: container.width,
        containerHeight: container.height
      });
      this.syncAdjacentPreviews();
    }
  }

  private cacheFits(cached: PrefetchedPage): boolean {
    return cached.pageNumber === this.page && this.cacheDimensionsFit(cached);
  }

  private cacheDimensionsFit(cached: PrefetchedPage): boolean {
    const container = this.containerSize();
    return cached.containerWidth === container.width
      && cached.containerHeight === container.height
      && cached.dpr === Math.min(window.devicePixelRatio, 2);
  }

  private syncAdjacentPreviews(): void {
    this.syncAdjacentPreview(this.previousPageCanvas, this.page - 1);
    this.syncAdjacentPreview(this.nextPageCanvas, this.page + 1);
  }

  private syncAdjacentPreview(target: HTMLCanvasElement, pageNumber: number): void {
    const cached = this.prefetched.get(pageNumber);
    if (!cached || !this.cacheDimensionsFit(cached)) {
      target.hidden = true;
      return;
    }
    target.width = cached.canvas.width;
    target.height = cached.canvas.height;
    target.style.width = `${cached.cssWidth}px`;
    target.style.height = `${cached.cssHeight}px`;
    const context = target.getContext("2d", { alpha: false });
    if (!context) {
      target.hidden = true;
      return;
    }
    context.drawImage(cached.canvas, 0, 0);
    target.hidden = false;
  }

  private containerSize(): { width: number; height: number } {
    return {
      width: Math.max(1, this.host.parentElement?.clientWidth ?? window.innerWidth),
      height: Math.max(1, this.host.parentElement?.clientHeight ?? window.innerHeight)
    };
  }
}

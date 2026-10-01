import { AnnotationType, GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Size } from "./layout";
import { destinationTarget } from "./outline";
import type { PdfOutlineNode } from "./outline";
import { extractPdfLinks } from "./links";
import type { PdfLink } from "./links";
import { transformedTextBounds } from "./search";
import type { SearchPageText, SearchTextItem } from "./search";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfDescriptor {
  id: string;
  name: string;
  byteLength: number;
}

export interface PdfRenderJob {
  readonly width: number;
  readonly height: number;
  readonly promise: Promise<void>;
  cancel(): void;
}

export class PdfPageHandle {
  readonly size: Size;

  constructor(private readonly page: PDFPageProxy) {
    const viewport = page.getViewport({ scale: 1 });
    this.size = { width: viewport.width, height: viewport.height };
  }

  render(canvas: HTMLCanvasElement, scale: number, dpr: number): PdfRenderJob {
    const viewport = this.page.getViewport({ scale });
    const pixelRatio = Math.max(0.5, dpr);
    canvas.width = Math.max(1, Math.ceil(viewport.width * pixelRatio));
    canvas.height = Math.max(1, Math.ceil(viewport.height * pixelRatio));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("A 2D canvas context is required to render a PDF page.");
    const task = this.page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0]
    });
    return renderJob(task, viewport.width, viewport.height);
  }

  cleanup(): void {
    this.page.cleanup();
  }
}

export class PdfDocument {
  private static readonly maximumRetainedPages = 12;
  private readonly pages = new Map<number, Promise<PdfPageHandle>>();
  private readonly sizes = new Map<number, Size>();
  private readonly links = new Map<number, Promise<PdfLink[]>>();

  private constructor(
    readonly descriptor: PdfDescriptor,
    private readonly loadingTask: PDFDocumentLoadingTask,
    private readonly document: PDFDocumentProxy
  ) {}

  static async open(bytes: Uint8Array, descriptor: PdfDescriptor): Promise<PdfDocument> {
    if (bytes.byteLength === 0) throw new Error("The selected PDF is empty.");
    const loadingTask = getDocument({ data: bytes });
    try {
      const document = await loadingTask.promise;
      return new PdfDocument(descriptor, loadingTask, document);
    } catch (error) {
      await loadingTask.destroy();
      throw new Error(`Unable to open ${descriptor.name}: ${errorMessage(error)}`, { cause: error });
    }
  }

  get pageCount(): number {
    return this.document.numPages;
  }

  get fingerprint(): string {
    return this.document.fingerprints[0] ?? this.descriptor.id;
  }

  page(pageNumber: number): Promise<PdfPageHandle> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
      return Promise.reject(new RangeError(`PDF page ${pageNumber} is outside 1-${this.pageCount}.`));
    }
    const existing = this.pages.get(pageNumber);
    if (existing) {
      this.pages.delete(pageNumber);
      this.pages.set(pageNumber, existing);
      return existing;
    }
    const pending = this.document.getPage(pageNumber).then((page) => {
      const handle = new PdfPageHandle(page);
      this.sizes.set(pageNumber, handle.size);
      return handle;
    });
    this.pages.set(pageNumber, pending);
    void pending.then(() => this.trimRetainedPages()).catch(() => this.pages.delete(pageNumber));
    return pending;
  }

  async pageSize(pageNumber: number): Promise<Size> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
      throw new RangeError(`PDF page ${pageNumber} is outside 1-${this.pageCount}.`);
    }
    const known = this.sizes.get(pageNumber);
    if (known) return known;
    const retained = this.pages.get(pageNumber);
    if (retained) return (await retained).size;
    const page = await this.document.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const size = { width: viewport.width, height: viewport.height };
      this.sizes.set(pageNumber, size);
      return size;
    } finally {
      page.cleanup();
    }
  }

  async pageText(pageNumber: number, signal?: AbortSignal): Promise<SearchPageText> {
    this.assertPageNumber(pageNumber);
    throwIfAborted(signal);
    const page = await this.document.getPage(pageNumber);
    try {
      throwIfAborted(signal);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ disableNormalization: false });
      throwIfAborted(signal);
      const items: SearchTextItem[] = content.items.flatMap((item) => {
        if (!("str" in item) || item.str.length === 0) return [];
        const bounds = transformedTextBounds(item.transform, viewport.transform, item.width, item.height);
        return [{ text: item.str, ...bounds }];
      });
      return { pageNumber, width: viewport.width, height: viewport.height, items };
    } finally {
      page.cleanup();
    }
  }

  async outline(): Promise<PdfOutlineNode[]> {
    const outline = await this.document.getOutline();
    return (outline ?? []).map(mapOutlineNode);
  }

  pageLinks(pageNumber: number): Promise<PdfLink[]> {
    this.assertPageNumber(pageNumber);
    const existing = this.links.get(pageNumber);
    if (existing) return existing;
    const pending = this.document.getPage(pageNumber).then(async (page) => {
      try {
        const viewport = page.getViewport({ scale: 1 });
        return extractPdfLinks(await page.getAnnotations({ intent: "display" }), AnnotationType.LINK, viewport);
      } finally {
        page.cleanup();
      }
    });
    this.links.set(pageNumber, pending);
    void pending.catch(() => this.links.delete(pageNumber));
    return pending;
  }

  async resolveDestination(destination: unknown): Promise<number | undefined> {
    const resolved = typeof destination === "string" ? await this.document.getDestination(destination) : destination;
    const target = destinationTarget(resolved);
    if (!target) return undefined;
    try {
      const index = target.kind === "index"
        ? target.index
        : await this.document.getPageIndex(target.reference);
      const page = index + 1;
      return page >= 1 && page <= this.pageCount ? page : undefined;
    } catch {
      return undefined;
    }
  }

  async destroy(): Promise<void> {
    for (const pending of this.pages.values()) {
      void pending.then((page) => page.cleanup()).catch(() => undefined);
    }
    this.pages.clear();
    this.sizes.clear();
    this.links.clear();
    await this.loadingTask.destroy();
  }

  private assertPageNumber(pageNumber: number): void {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
      throw new RangeError(`PDF page ${pageNumber} is outside 1-${this.pageCount}.`);
    }
  }

  private trimRetainedPages(): void {
    while (this.pages.size > PdfDocument.maximumRetainedPages) {
      const oldest = this.pages.entries().next().value as [number, Promise<PdfPageHandle>] | undefined;
      if (!oldest) return;
      this.pages.delete(oldest[0]);
      void oldest[1].then((page) => page.cleanup()).catch(() => undefined);
    }
  }
}

export function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

function renderJob(task: RenderTask, width: number, height: number): PdfRenderJob {
  return {
    width,
    height,
    promise: task.promise,
    cancel: () => task.cancel()
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was cancelled.", "AbortError");
}

interface NativeOutlineNode {
  title: string;
  dest: unknown;
  items: NativeOutlineNode[];
}

function mapOutlineNode(node: NativeOutlineNode): PdfOutlineNode {
  return {
    title: node.title,
    dest: node.dest,
    items: node.items.map(mapOutlineNode)
  };
}

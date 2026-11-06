import type { PDFWorker as PdfWorkerInstance } from "pdfjs-dist";
import type { PdfDescriptor, PdfDocument } from "./doc";

/**
 * Dedicated thumbnail workers. Image decoding for scanned pages is expensive
 * and serialized inside a single pdf.js worker, so the grid can additionally
 * open per-document worker instances that decode other pages in parallel while
 * the reading document stays untouched. Each instance costs one extra copy of
 * the document bytes, which is why the pool only lives while the grid does.
 */

export interface ThumbnailPoolTask {
  readonly pageNumber: number;
}

export type ThumbnailPoolRunner<TTask extends ThumbnailPoolTask> = (source: PdfDocument, task: TTask) => Promise<void>;

export interface ThumbnailWorkerPoolOptions {
  readonly size: number;
  readonly descriptor: PdfDescriptor;
  /** Reads a fresh byte copy per document; pdf.js takes ownership of it. */
  readonly readBytes: () => Promise<Uint8Array>;
  readonly openDocument: (bytes: Uint8Array, descriptor: PdfDescriptor, worker: PdfWorkerInstance) => Promise<PdfDocument>;
  readonly createWorker: () => Promise<PdfWorkerInstance>;
}

export class ThumbnailWorkerPool {
  private documents: PdfDocument[] = [];
  private workers: PdfWorkerInstance[] = [];
  private opening?: Promise<boolean>;
  private nextTaskIndex = 0;

  constructor(private readonly options: ThumbnailWorkerPoolOptions) {}

  get active(): boolean {
    return this.documents.length > 0;
  }

  /**
   * Opens the pool's worker documents once; later settles reuse them. A pool
   * where only some workers started stays usable, and total failure surfaces
   * to the caller so it can degrade to the plain schedule.
   */
  readonly ensure = (): Promise<boolean> => {
    this.opening ??= this.start();
    return this.opening;
  };

  private async start(): Promise<boolean> {
    const startups: Promise<void>[] = [];
    for (let workerIndex = 0; workerIndex < this.options.size; workerIndex += 1) {
      startups.push(
        (async () => {
          // Each worker is created before its document so the document binds
          // to a dedicated thread instead of pdf.js's shared global worker.
          const worker = await this.options.createWorker();
          this.workers.push(worker);
          try {
            const bytes = await this.options.readBytes();
            const document = await this.options.openDocument(bytes, this.options.descriptor, worker);
            this.documents.push(document);
          } catch (error) {
            console.warn(`Thumbnail worker ${workerIndex} could not be started`, error);
          }
        })()
      );
    }
    await Promise.all(startups);
    return this.documents.length > 0;
  }

  async settle<TTask extends ThumbnailPoolTask>(
    tasks: readonly TTask[],
    run: (source: PdfDocument, task: TTask) => Promise<void>,
    shouldContinue: () => boolean
  ): Promise<void> {
    if (!this.documents.length) return;
    this.nextTaskIndex = 0;
    const loops = this.documents.map(async (source) => {
      while (shouldContinue()) {
        const task = tasks.at(this.nextTaskIndex);
        if (!task) return;
        this.nextTaskIndex += 1;
        try {
          await run(source, task);
        } catch {
          // Job failures were already reported by the runner; keep working.
        }
      }
    });
    await Promise.all(loops);
  }

  /** Fully releases the pool once it is no longer scheduled for this document. */
  async destroy(): Promise<void> {
    if (this.opening) await this.opening.catch(() => undefined);
    const documents = this.documents;
    this.documents = [];
    for (const document of documents) await document.destroy().catch(() => undefined);
    const workers = this.workers;
    this.workers = [];
    for (const worker of workers) worker.destroy();
  }
}

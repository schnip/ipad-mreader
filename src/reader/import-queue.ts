import { IMPORT_RETRY_MS } from "../core/tuning";

/**
 * Serializes PDF imports from every ingress path (picker, file handlers, share
 * target). Files wait until startup restoration finishes, then import one at a
 * time, retrying shortly while another document is still opening.
 */
export class ImportQueue {
  private readonly pending: File[] = [];
  private ready = false;
  private running = false;
  private retryTimer?: number;

  constructor(
    private readonly isBusy: () => boolean,
    private readonly importFile: (file: File) => Promise<void>
  ) {}

  get size(): number {
    return this.pending.length;
  }

  enqueue(files: readonly File[]): void {
    this.pending.push(...files);
    this.drain();
  }

  /** Allows queued imports to run; call once the stored session is restored. */
  start(): void {
    this.ready = true;
    this.drain();
  }

  private drain(): void {
    if (!this.ready || this.running || this.pending.length === 0) return;
    if (this.isBusy()) {
      if (this.retryTimer === undefined) {
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = undefined;
          this.drain();
        }, IMPORT_RETRY_MS);
      }
      return;
    }
    const file = this.pending.shift();
    if (!file) return;
    this.running = true;
    void this.importFile(file).finally(() => {
      this.running = false;
      this.drain();
    });
  }
}

/**
 * Build-time platform seam. Exactly one implementation (web or native) is
 * bundled, selected by the `@mreader/platform` alias in vite.config.ts.
 */
export interface Platform {
  /** Registers offline support where it applies. Never rejects. */
  registerServiceWorker(): Promise<void>;
  /**
   * Hands an exported file to the user. Rejects with an `AbortError`-named
   * error when the user cancels, so callers can treat cancellation quietly.
   */
  deliverExport(file: File): Promise<void>;
  /** Opens an already-confirmed, already-validated safe external URL. */
  openExternalUrl(url: string): void;
  /**
   * Installs system back handling. `dismissForemost` dismisses the foremost
   * dismissible UI and returns whether anything was dismissed.
   */
  installBackHandler(dismissForemost: () => boolean): void;
  /**
   * Installs external file ingress. Files may be enqueued at any time after
   * installation. The returned function delivers startup-deferred ingress and
   * must be awaited once, after the stored session has been restored.
   */
  installIngress(enqueue: (files: File[]) => void, reportError: (message: string) => void): () => Promise<void>;
}

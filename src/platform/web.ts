import type { Platform } from "./types";

interface FileLaunchParams {
  files?: readonly FileSystemFileHandle[];
}

interface FileLaunchQueue {
  setConsumer(consumer: (params: FileLaunchParams) => void): void;
}

interface SharedTargetRequest {
  id?: string;
  error?: string;
}

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

async function deliverExport(file: File): Promise<void> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return;
    } catch (error) {
      // Safari requires transient user activation for share(). If it expired
      // (`NotAllowedError`), fall back to a download instead of failing.
      if (!(error instanceof DOMException) || error.name !== "NotAllowedError") throw error;
    }
  }
  downloadFile(file);
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel the download in Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function openExternalUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

function installBackHandler(): void {
  // The web build has no hardware back button; it only defends against
  // Safari's edge-swipe/back navigation leaving the app.
  history.replaceState({ mreader: "root" }, "");
  history.pushState({ mreader: "guard" }, "");
  window.addEventListener("popstate", () => history.pushState({ mreader: "guard" }, ""));
}

function installIngress(enqueue: (files: File[]) => void, reportError: (message: string) => void): () => Promise<void> {
  const sharedTarget = takeSharedTargetRequest();
  installFileLaunchConsumer(enqueue, reportError);
  return async () => {
    if (sharedTarget.error) reportError(sharedTarget.error);
    if (sharedTarget.id) {
      try {
        enqueue([await readSharedTargetFile(sharedTarget.id)]);
      } catch (error) {
        reportError(`Unable to receive shared PDF: ${errorMessage(error)}`);
      }
    }
  };
}

function installFileLaunchConsumer(enqueue: (files: File[]) => void, reportError: (message: string) => void): void {
  const launchQueue = (window as Window & { launchQueue?: FileLaunchQueue }).launchQueue;
  const launchParams = (globalThis as typeof globalThis & { LaunchParams?: { prototype: object } }).LaunchParams;
  if (!launchQueue || !launchParams || !("files" in launchParams.prototype)) return;
  launchQueue.setConsumer((params) => {
    void receiveLaunchedFiles(params.files ?? [], enqueue, reportError);
  });
}

async function receiveLaunchedFiles(handles: readonly FileSystemFileHandle[], enqueue: (files: File[]) => void, reportError: (message: string) => void): Promise<void> {
  for (const handle of handles) {
    try {
      enqueue([await handle.getFile()]);
    } catch (error) {
      reportError(`Unable to open launched PDF: ${errorMessage(error)}`);
    }
  }
}

function takeSharedTargetRequest(): SharedTargetRequest {
  const url = new URL(window.location.href);
  const id = url.searchParams.get("mreader-share") ?? undefined;
  const shareError = url.searchParams.get("mreader-share-error");
  if (!id && !shareError) return {};
  url.searchParams.delete("mreader-share");
  url.searchParams.delete("mreader-share-error");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return {
    id,
    error: shareError ? "Only non-empty PDF files can be shared to mreader." : undefined
  };
}

async function readSharedTargetFile(id: string): Promise<File> {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error("The shared file identifier is invalid.");
  const response = await fetch(new URL(`./__mreader_shared_pdf__/${encodeURIComponent(id)}`, document.baseURI));
  if (!response.ok) throw new Error("The shared file is no longer available.");
  const encodedName = response.headers.get("X-Mreader-Filename");
  let name = "shared.pdf";
  if (encodedName) {
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      name = "shared.pdf";
    }
  }
  if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
  return new File([await response.blob()], name, { type: "application/pdf", lastModified: Date.now() });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const platform: Platform = {
  registerServiceWorker,
  deliverExport,
  openExternalUrl,
  installBackHandler,
  installIngress
};

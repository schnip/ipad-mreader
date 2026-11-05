import { App } from "@capacitor/app";
import { AppLauncher } from "@capacitor/app-launcher";
import { Capacitor } from "@capacitor/core";
import { Filesystem } from "@capacitor/filesystem";
import type { Platform } from "./types";

// Shared by the Android and iOS Capacitor shells (PLAN_APK.md, PLAN_IOS.md).

function registerServiceWorker(): Promise<void> {
  // Assets are bundled in the APK/IPA; a service worker adds nothing natively,
  // and WKWebView does not run service workers on the capacitor:// scheme.
  return Promise.resolve();
}

function deliverExport(): Promise<void> {
  // Implemented in PLAN_APK.md A3 (Filesystem cache + @capacitor/share), shared by iOS.
  return Promise.reject(new Error("Exporting an annotated copy is not yet supported in the native app."));
}

function openExternalUrl(url: string): void {
  // Only already-confirmed, already-validated safe URLs reach this call.
  void AppLauncher.openUrl({ url }).catch((error: unknown) => {
    console.warn("Unable to open external link", error);
  });
}

function installBackHandler(dismissForemost: () => boolean): void {
  // Android only: iOS has no back button, so this listener never fires there.
  void App.addListener("backButton", () => {
    if (!dismissForemost()) void App.exitApp();
  });
}

/**
 * iOS "Open in mreader" / Share ingress. Info.plist declares PDF document
 * support with LSSupportsOpeningDocumentsInPlace=false, so iOS copies the
 * file into the app's Documents/Inbox and opens the app with its file:// URL,
 * which Capacitor's App plugin reports as `appUrlOpen` (retained across a cold
 * start until a listener consumes it). Android content:// ingress is
 * PLAN_APK.md A2 and is not handled here.
 */
function installIngress(enqueue: (files: File[]) => void, reportError: (message: string) => void): () => Promise<void> {
  const deferred: string[] = [];
  let ready = false;
  void App.addListener("appUrlOpen", ({ url }) => {
    if (!isFileUrl(url)) return;
    if (ready) void receiveOpenedFile(url, enqueue, reportError);
    else deferred.push(url);
  });
  return async () => {
    ready = true;
    for (const url of deferred.splice(0)) await receiveOpenedFile(url, enqueue, reportError);
  };
}

function isFileUrl(url: string): boolean {
  return url.startsWith("file://");
}

async function receiveOpenedFile(url: string, enqueue: (files: File[]) => void, reportError: (message: string) => void): Promise<void> {
  const name = openedFileName(url);
  try {
    const response = await fetch(Capacitor.convertFileSrc(url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    enqueue([new File([blob], name, { type: "application/pdf" })]);
  } catch (error) {
    reportError(`Unable to open ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await removeInboxCopy(url);
}

function openedFileName(url: string): string {
  const segment = url.split(/[?#]/)[0]?.split("/").pop() ?? "";
  try {
    return decodeURIComponent(segment) || "Opened PDF.pdf";
  } catch {
    return segment || "Opened PDF.pdf";
  }
}

/**
 * The bytes are already in memory, so the copy iOS made in this app's
 * Documents/Inbox is redundant. Only that app-owned copy is ever removed;
 * the user's original in Files is untouched.
 */
async function removeInboxCopy(url: string): Promise<void> {
  if (!url.includes("/Documents/Inbox/")) return;
  await Filesystem.deleteFile({ path: url }).catch((error: unknown) => {
    console.warn("Unable to remove the Inbox copy of an opened PDF", error);
  });
}

export const platform: Platform = {
  registerServiceWorker,
  deliverExport,
  openExternalUrl,
  installBackHandler,
  installIngress
};

import { App } from "@capacitor/app";
import { AppLauncher } from "@capacitor/app-launcher";
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

function installIngress(): () => Promise<void> {
  // Open with / Share ingress is implemented in PLAN_APK.md A2.
  return () => Promise.resolve();
}

export const platform: Platform = {
  registerServiceWorker,
  deliverExport,
  openExternalUrl,
  installBackHandler,
  installIngress
};

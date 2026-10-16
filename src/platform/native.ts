import { App } from "@capacitor/app";
import { AppLauncher } from "@capacitor/app-launcher";
import type { Platform } from "./types";

async function registerServiceWorker(): Promise<void> {
  // Assets are bundled in the APK; a service worker adds nothing natively.
}

async function deliverExport(): Promise<void> {
  // Implemented in PLAN_APK.md A3 (Filesystem cache + @capacitor/share).
  throw new Error("Exporting an annotated copy is not yet supported on Android.");
}

function openExternalUrl(url: string): void {
  // Only already-confirmed, already-validated safe URLs reach this call.
  void AppLauncher.openUrl({ url }).catch((error: unknown) => {
    console.warn("Unable to open external link", error);
  });
}

function installBackHandler(dismissForemost: () => boolean): void {
  void App.addListener("backButton", () => {
    if (!dismissForemost()) void App.exitApp();
  });
}

function installIngress(): () => Promise<void> {
  // Open with / Share ingress is implemented in PLAN_APK.md A2.
  return async () => {};
}

export const platform: Platform = {
  registerServiceWorker,
  deliverExport,
  openExternalUrl,
  installBackHandler,
  installIngress
};

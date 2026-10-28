import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitor = vi.hoisted(() => ({
  addListener: vi.fn(),
  exitApp: vi.fn(),
  openUrl: vi.fn()
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: capacitor.addListener, exitApp: capacitor.exitApp }
}));

vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: { openUrl: capacitor.openUrl }
}));

import { platform } from "./native";

function installedBackListener(): () => void {
  const call = capacitor.addListener.mock.calls[0] as [string, () => void] | undefined;
  if (!call) throw new Error("No back listener was installed.");
  expect(call[0]).toBe("backButton");
  return call[1];
}

describe("native platform", () => {
  beforeEach(() => {
    capacitor.addListener.mockReset().mockResolvedValue({ remove: vi.fn() });
    capacitor.exitApp.mockReset().mockResolvedValue(undefined);
    capacitor.openUrl.mockReset().mockResolvedValue({ completed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dismisses the foremost UI on back without exiting", () => {
    const dismissForemost = vi.fn(() => true);
    platform.installBackHandler(dismissForemost);
    installedBackListener()();
    expect(dismissForemost).toHaveBeenCalledTimes(1);
    expect(capacitor.exitApp).not.toHaveBeenCalled();
  });

  it("exits only when back has nothing left to dismiss", () => {
    const dismissForemost = vi.fn(() => false);
    platform.installBackHandler(dismissForemost);
    installedBackListener()();
    expect(dismissForemost).toHaveBeenCalledTimes(1);
    expect(capacitor.exitApp).toHaveBeenCalledTimes(1);
  });

  it("opens external URLs through the system app launcher", () => {
    platform.openExternalUrl("mailto:reader@example.com");
    expect(capacitor.openUrl).toHaveBeenCalledWith({ url: "mailto:reader@example.com" });
  });

  it("contains app launcher failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    capacitor.openUrl.mockRejectedValueOnce(new Error("no handler"));
    platform.openExternalUrl("https://example.com/");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it("rejects export delivery clearly until A3 implements it", async () => {
    const file = new File([new Uint8Array([1])], "copy.pdf", { type: "application/pdf" });
    await expect(platform.deliverExport(file)).rejects.toThrow("not yet supported in the native app");
  });

  it("treats the service worker and A1 ingress as no-ops", async () => {
    await expect(platform.registerServiceWorker()).resolves.toBeUndefined();
    const enqueue = vi.fn();
    const reportError = vi.fn();
    await platform.installIngress(enqueue, reportError)();
    expect(enqueue).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});

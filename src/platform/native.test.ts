import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitor = vi.hoisted(() => ({
  addListener: vi.fn(),
  exitApp: vi.fn(),
  openUrl: vi.fn(),
  deleteFile: vi.fn()
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: capacitor.addListener, exitApp: capacitor.exitApp }
}));

vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: { openUrl: capacitor.openUrl }
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { convertFileSrc: (url: string) => `converted:${url}` }
}));

vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { deleteFile: capacitor.deleteFile }
}));

import { platform } from "./native";

function urlOpenListener(): (event: { url: string }) => void {
  const call = capacitor.addListener.mock.calls.find((candidate) => candidate[0] === "appUrlOpen") as
    | [string, (event: { url: string }) => void]
    | undefined;
  if (!call) throw new Error("No appUrlOpen listener was installed.");
  return call[1];
}

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
    capacitor.deleteFile.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("treats the service worker as a no-op", async () => {
    await expect(platform.registerServiceWorker()).resolves.toBeUndefined();
  });

  it("defers iOS opened PDFs until startup ingress is delivered, then removes the Inbox copy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const enqueue = vi.fn();
    const reportError = vi.fn();
    const deliver = platform.installIngress(enqueue, reportError);
    const url = "file:///var/mobile/Containers/Data/Application/X/Documents/Inbox/My%20Book.pdf";
    urlOpenListener()({ url });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    await deliver();
    expect(fetchMock).toHaveBeenCalledWith(`converted:${url}`);
    const files = enqueue.mock.calls[0]?.[0] as File[];
    expect(files[0]?.name).toBe("My Book.pdf");
    expect(files[0]?.type).toBe("application/pdf");
    expect(files[0]?.size).toBe(4);
    expect(capacitor.deleteFile).toHaveBeenCalledWith({ path: url });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("imports immediately after startup, ignores non-file URLs, and keeps non-Inbox files", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const enqueue = vi.fn();
    await platform.installIngress(enqueue, vi.fn())();
    urlOpenListener()({ url: "mreader://open" });
    urlOpenListener()({ url: "file:///private/var/tmp/a.pdf" });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capacitor.deleteFile).not.toHaveBeenCalled();
  });

  it("reports an unreadable opened file without enqueueing or deleting it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const enqueue = vi.fn();
    const reportError = vi.fn();
    await platform.installIngress(enqueue, reportError)();
    urlOpenListener()({ url: "file:///x/Documents/Inbox/b.pdf" });
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith("Unable to open b.pdf: HTTP 404"));
    expect(enqueue).not.toHaveBeenCalled();
    expect(capacitor.deleteFile).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platform } from "./web";

interface FakeAnchor {
  href: string;
  download: string;
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

interface Harness {
  window: {
    isSecureContext: boolean;
    location: { href: string };
    open: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    launchQueue?: { setConsumer: ReturnType<typeof vi.fn> };
  };
  history: { state: unknown; replaceState: ReturnType<typeof vi.fn>; pushState: ReturnType<typeof vi.fn> };
  anchors: FakeAnchor[];
  append: ReturnType<typeof vi.fn>;
}

function installHarness(): Harness {
  const anchors: FakeAnchor[] = [];
  const append = vi.fn();
  const harness: Harness = {
    window: {
      isSecureContext: true,
      location: { href: "https://reader.example/app/" },
      open: vi.fn(),
      setTimeout: vi.fn(),
      addEventListener: vi.fn()
    },
    history: { state: null, replaceState: vi.fn(), pushState: vi.fn() },
    anchors,
    append
  };
  vi.stubGlobal("window", harness.window);
  vi.stubGlobal("history", harness.history);
  vi.stubGlobal("document", {
    baseURI: "https://reader.example/app/",
    body: { append },
    createElement: (tag: string) => {
      expect(tag).toBe("a");
      const anchor: FakeAnchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
      anchors.push(anchor);
      return anchor;
    }
  });
  return harness;
}

const pdf = (): File => new File([new Uint8Array([37, 80, 68, 70])], "notes-annotated.pdf", { type: "application/pdf" });

describe("web platform", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = installHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("registerServiceWorker", () => {
    it("registers the root-scoped worker in a secure context", async () => {
      const register = vi.fn().mockResolvedValue({});
      vi.stubGlobal("navigator", { serviceWorker: { register } });
      await platform.registerServiceWorker();
      expect(register).toHaveBeenCalledWith("./sw.js", { scope: "./" });
    });

    it("skips registration outside a secure context", async () => {
      const register = vi.fn();
      vi.stubGlobal("navigator", { serviceWorker: { register } });
      harness.window.isSecureContext = false;
      await platform.registerServiceWorker();
      expect(register).not.toHaveBeenCalled();
    });

    it("skips registration without service worker support", async () => {
      vi.stubGlobal("navigator", {});
      await expect(platform.registerServiceWorker()).resolves.toBeUndefined();
    });

    it("warns instead of rejecting when registration fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.stubGlobal("navigator", { serviceWorker: { register: vi.fn().mockRejectedValue(new Error("blocked")) } });
      await expect(platform.registerServiceWorker()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith("Service worker registration failed", expect.any(Error));
    });
  });

  describe("deliverExport", () => {
    it("uses the system share sheet when files can be shared", async () => {
      const share = vi.fn().mockResolvedValue(undefined);
      const canShare = vi.fn(() => true);
      vi.stubGlobal("navigator", { canShare, share });
      const file = pdf();
      await platform.deliverExport(file);
      expect(canShare).toHaveBeenCalledWith({ files: [file] });
      expect(share).toHaveBeenCalledWith({ files: [file], title: "notes-annotated.pdf" });
      expect(harness.anchors).toHaveLength(0);
    });

    it("propagates share cancellation as an AbortError", async () => {
      const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
      vi.stubGlobal("navigator", { canShare: () => true, share: vi.fn().mockRejectedValue(abort) });
      await expect(platform.deliverExport(pdf())).rejects.toMatchObject({ name: "AbortError" });
    });

    it("falls back to an attached download anchor with a deferred revoke", async () => {
      vi.stubGlobal("navigator", { canShare: () => false, share: vi.fn() });
      const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
      const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
      const file = pdf();
      await platform.deliverExport(file);
      expect(createObjectURL).toHaveBeenCalledWith(file);
      const [anchor] = harness.anchors;
      expect(anchor).toMatchObject({ href: "blob:export", download: "notes-annotated.pdf" });
      expect(harness.append).toHaveBeenCalledWith(anchor);
      expect(anchor?.click).toHaveBeenCalledTimes(1);
      expect(anchor?.remove).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      const [callback, delay] = harness.window.setTimeout.mock.calls[0] as [() => void, number];
      expect(delay).toBe(30_000);
      callback();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:export");
    });

    it("falls back to download when canShare is unavailable", async () => {
      const share = vi.fn();
      vi.stubGlobal("navigator", { share });
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
      await platform.deliverExport(pdf());
      expect(share).not.toHaveBeenCalled();
      expect(harness.anchors).toHaveLength(1);
    });

    it("falls back to download when share activation has expired", async () => {
      const notAllowed = new DOMException("activation expired", "NotAllowedError");
      vi.stubGlobal("navigator", { canShare: () => true, share: vi.fn().mockRejectedValue(notAllowed) });
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
      await platform.deliverExport(pdf());
      expect(harness.anchors).toHaveLength(1);
      expect(harness.anchors[0]?.click).toHaveBeenCalledTimes(1);
    });
  });

  it("opens external URLs in a separate, unlinked browsing context", () => {
    platform.openExternalUrl("https://example.com/");
    expect(harness.window.open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
  });

  it("installs the history defense and ignores the dismissal callback", () => {
    const dismissForemost = vi.fn(() => true);
    platform.installBackHandler(dismissForemost);
    expect(harness.history.replaceState).toHaveBeenCalledWith({ mreader: "root" }, "");
    expect(harness.history.pushState).toHaveBeenCalledWith({ mreader: "guard" }, "");
    const [type, listener] = harness.window.addEventListener.mock.calls[0] as [string, () => void];
    expect(type).toBe("popstate");
    listener();
    expect(harness.history.pushState).toHaveBeenCalledTimes(2);
    expect(dismissForemost).not.toHaveBeenCalled();
  });

  describe("installIngress", () => {
    it("does nothing without share parameters or launch support", async () => {
      const enqueue = vi.fn();
      const reportError = vi.fn();
      await platform.installIngress(enqueue, reportError)();
      expect(harness.history.replaceState).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it("strips share parameters immediately and delivers the shared file after restore", async () => {
      harness.window.location.href = "https://reader.example/app/?mreader-share=abcdef12&keep=1#top";
      const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "X-Mreader-Filename": encodeURIComponent("Résumé") } }));
      vi.stubGlobal("fetch", fetchMock);
      const enqueue = vi.fn();
      const reportError = vi.fn();
      const deliver = platform.installIngress(enqueue, reportError);
      expect(harness.history.replaceState).toHaveBeenCalledWith(null, "", "/app/?keep=1#top");
      expect(fetchMock).not.toHaveBeenCalled();
      await deliver();
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://reader.example/app/__mreader_shared_pdf__/abcdef12");
      const files = enqueue.mock.calls[0]?.[0] as File[];
      expect(files).toHaveLength(1);
      expect(files[0]?.name).toBe("Résumé.pdf");
      expect(files[0]?.type).toBe("application/pdf");
      expect(reportError).not.toHaveBeenCalled();
    });

    it("reports a share-target error and an unavailable shared file", async () => {
      harness.window.location.href = "https://reader.example/app/?mreader-share-error=1";
      const reportError = vi.fn();
      await platform.installIngress(vi.fn(), reportError)();
      expect(reportError).toHaveBeenCalledWith("Only non-empty PDF files can be shared to mreader.");

      harness.window.location.href = "https://reader.example/app/?mreader-share=abcdef12";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      const enqueue = vi.fn();
      await platform.installIngress(enqueue, reportError)();
      expect(enqueue).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenLastCalledWith("Unable to receive shared PDF: The shared file is no longer available.");
    });

    it("rejects malformed share identifiers without fetching", async () => {
      harness.window.location.href = "https://reader.example/app/?mreader-share=bad";
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const reportError = vi.fn();
      await platform.installIngress(vi.fn(), reportError)();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith("Unable to receive shared PDF: The shared file identifier is invalid.");
    });

    it("enqueues files from the launch queue and reports unreadable handles", async () => {
      const setConsumer = vi.fn();
      harness.window.launchQueue = { setConsumer };
      vi.stubGlobal("LaunchParams", class { get files(): unknown[] { return []; } });
      const enqueue = vi.fn();
      const reportError = vi.fn();
      platform.installIngress(enqueue, reportError);
      const consumer = setConsumer.mock.calls[0]?.[0] as (params: { files?: unknown[] }) => void;
      const launched = pdf();
      consumer({
        files: [
          { getFile: () => Promise.resolve(launched) },
          { getFile: () => Promise.reject(new Error("revoked")) }
        ]
      });
      await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith("Unable to open launched PDF: revoked"));
      expect(enqueue).toHaveBeenCalledWith([launched]);
    });

    it("ignores a launch queue without file launch support", () => {
      const setConsumer = vi.fn();
      harness.window.launchQueue = { setConsumer };
      platform.installIngress(vi.fn(), vi.fn());
      expect(setConsumer).not.toHaveBeenCalled();
    });
  });
});

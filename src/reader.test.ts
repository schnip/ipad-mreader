// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfDocument } from "./core/doc";
import type { SearchPageText } from "./core/search";
import type * as OpfsModule from "./store/opfs";
import type * as SessionModule from "./store/session";
import type * as SidecarModule from "./store/sidecar";

const platformMock = vi.hoisted(() => ({
  registerServiceWorker: vi.fn(() => Promise.resolve()),
  deliverExport: vi.fn((file: File) => Promise.resolve(void file)),
  openExternalUrl: vi.fn(),
  installBackHandler: vi.fn(),
  installIngress: vi.fn(() => () => Promise.resolve())
}));

const storage = vi.hoisted(() => ({
  importPdf: vi.fn(),
  readPdf: vi.fn(),
  listPdfs: vi.fn(),
  putAnnotation: vi.fn(),
  open: vi.fn()
}));

vi.mock("./platform", () => ({ platform: platformMock }));
vi.mock("./core/doc", () => ({ PdfDocument: { open: storage.open } }));
vi.mock("./core/export", () => ({
  exportAnnotatedPdf: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([37, 80, 68, 70]), fileName: "Book annotated.pdf", noteCount: 0, skipped: 0 }))
}));
vi.mock("./store/opfs", async (importOriginal) => ({
  ...await importOriginal<typeof OpfsModule>(),
  importPdf: storage.importPdf,
  readPdf: storage.readPdf,
  listPdfs: storage.listPdfs,
  deletePdf: vi.fn(() => Promise.resolve())
}));
vi.mock("./store/sidecar", async (importOriginal) => ({
  ...await importOriginal<typeof SidecarModule>(),
  listRecentDocuments: vi.fn(() => Promise.resolve([])),
  putDocumentSidecar: vi.fn(() => Promise.resolve()),
  updateReadingPosition: vi.fn(() => Promise.resolve()),
  deleteDocumentSidecar: vi.fn(() => Promise.resolve())
}));
vi.mock("./store/session", async (importOriginal) => ({
  ...await importOriginal<typeof SessionModule>(),
  loadOpenSession: vi.fn(() => Promise.resolve(undefined)),
  saveOpenSession: vi.fn(() => Promise.resolve())
}));
vi.mock("./store/annotations", () => ({
  listDocumentAnnotations: vi.fn(() => Promise.resolve([])),
  putAnnotation: storage.putAnnotation,
  deleteAnnotation: vi.fn(() => Promise.resolve(true))
}));

import { ReaderApplication } from "./reader";

const pageText = (pageNumber: number): SearchPageText => ({
  pageNumber,
  width: 600,
  height: 800,
  items: [
    { text: "Hello", x: 100, y: 100, width: 60, height: 12 },
    { text: "world", x: 170, y: 100, width: 60, height: 12 }
  ]
});

function fakeDocument(id: string): PdfDocument {
  return {
    descriptor: { id, name: "Book.pdf", byteLength: 10 },
    pageCount: 3,
    fingerprint: `fp-${id}`,
    page: () => Promise.resolve({
      size: { width: 600, height: 800 },
      render: (canvas: HTMLCanvasElement) => {
        canvas.width = 6;
        canvas.height = 8;
        return { width: 6, height: 8, promise: Promise.resolve(), cancel: () => undefined };
      },
      cleanup: () => undefined
    }),
    pageSize: () => Promise.resolve({ width: 600, height: 800 }),
    pageText: (pageNumber: number) => Promise.resolve(pageText(pageNumber)),
    pageLinks: () => Promise.resolve([]),
    outline: () => Promise.resolve([]),
    resolveDestination: () => Promise.resolve(undefined),
    destroy: () => Promise.resolve()
  } as unknown as PdfDocument;
}

interface ReaderInternals {
  enqueuePdfImports(files: File[]): void;
  selection?: unknown;
  annotations: unknown[];
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function $(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

async function openReader(): Promise<{ reader: ReaderApplication; internals: ReaderInternals }> {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const reader = new ReaderApplication(root);
  await reader.start();
  const internals = reader as unknown as ReaderInternals;
  internals.enqueuePdfImports([new File([new Uint8Array([1])], "Book.pdf", { type: "application/pdf" })]);
  await settle();
  return { reader, internals };
}

function pointer(type: string, target: Element, pointerType: string): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType, pointerId: 7, clientX: 10, clientY: 10, pressure: 0.5 });
  target.dispatchEvent(event);
}

function touch(type: string, target: Element, points: { x: number; y: number }[]): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = points.map((point, identifier) => ({ identifier, clientX: point.x, clientY: point.y, target }));
  Object.assign(event, { touches, changedTouches: touches, targetTouches: touches });
  target.dispatchEvent(event);
}

describe("reader application (DOM)", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D);
    let counter = 0;
    storage.importPdf.mockImplementation(() => Promise.resolve({ id: `document-${++counter}`, size: 10, lastModified: 1 }));
    storage.readPdf.mockResolvedValue(new Uint8Array([1]));
    storage.listPdfs.mockResolvedValue([]);
    storage.putAnnotation.mockImplementation((annotation: unknown) => Promise.resolve(annotation));
    storage.open.mockImplementation((_bytes: Uint8Array, descriptor: { id: string }) => Promise.resolve(fakeDocument(descriptor.id)));
    platformMock.deliverExport.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("imports a PDF, hides the empty state, and keeps hidden bars inert", async () => {
    await openReader();
    expect($("#empty-state").hidden).toBe(true);
    expect($("#current-page").getAttribute("aria-label")).toBe("Page 1 of 3");
    expect(($("#top-bar") as HTMLElement & { inert: boolean }).inert).toBe(true);
    expect(($("#bottom-bar") as HTMLElement & { inert: boolean }).inert).toBe(true);
    expect($("#document-tabs").textContent).toContain("Book.pdf");
  });

  it("opens Find with focus and returns focus when Escape closes it", async () => {
    await openReader();
    const opener = $("#corner-open");
    opener.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
    await settle();
    expect($("#find-panel").hidden).toBe(false);
    expect(document.activeElement).toBe($("#find-query"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect($("#find-panel").hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the selection when the Pencil taps a selection action", async () => {
    const { internals } = await openReader();
    internals.selection = { pageNumber: 1, geometry: { text: "Hello", rects: [], startHandle: { x: 0, y: 0, height: 0 }, endHandle: { x: 0, y: 0, height: 0 }, context: "Hello", range: { start: { itemIndex: 0, offset: 0 }, end: { itemIndex: 0, offset: 5 } } } };
    pointer("pointerdown", $("#selection-copy"), "pen");
    expect(internals.selection).toBeDefined();
    pointer("pointerdown", $("#reader-scene"), "pen");
    expect(internals.selection).toBeUndefined();
  });

  it("prepares an export first and shares it only from a fresh tap", async () => {
    const { internals } = await openReader();
    internals.annotations = [{ id: "a", kind: "highlight", pageNumber: 1 }];
    $("#export-open").click();
    await settle();
    expect(platformMock.deliverExport).not.toHaveBeenCalled();
    expect($("#drawer-panel").hidden).toBe(false);
    const share = $("[data-export-share]");
    expect(document.activeElement).toBe(share);
    share.click();
    await settle();
    expect(platformMock.deliverExport).toHaveBeenCalledTimes(1);
    expect((platformMock.deliverExport.mock.calls[0]?.[0])?.name).toBe("Book annotated.pdf");
    expect($("#drawer-panel").hidden).toBe(true);
  });

  it("reports storage without deleting anything", async () => {
    storage.listPdfs.mockResolvedValue([{ id: "document-1", size: 2048, lastModified: 1 }, { id: "orphan-01", size: 1024, lastModified: 1 }]);
    await openReader();
    $("#storage-open").click();
    await settle();
    expect($("#drawer-title").textContent).toBe("Storage");
    expect($("#drawer-content").textContent).toContain("Not referenced by any document");
    expect($("#drawer-content").textContent).toContain("never deletes");
  });

  it("restores the fitted page and hides the grid when a shrinking pinch is cancelled", async () => {
    await openReader();
    const scene = $("#reader-scene");
    touch("touchstart", scene, [{ x: 100, y: 100 }, { x: 300, y: 300 }]);
    expect($("#thumbnail-grid").hidden).toBe(false);
    touch("touchmove", scene, [{ x: 120, y: 120 }, { x: 280, y: 280 }]);
    expect($("#page-track").style.transform).not.toContain("scale(1)");
    touch("touchcancel", scene, []);
    await settle();
    expect($("#thumbnail-grid").hidden).toBe(true);
    expect($("#page-track").style.transform).toContain("scale(1)");
  });

  it("settles into the grid when a pinch that crossed the threshold is cancelled", async () => {
    await openReader();
    const scene = $("#reader-scene");
    touch("touchstart", scene, [{ x: 100, y: 100 }, { x: 300, y: 300 }]);
    touch("touchmove", scene, [{ x: 180, y: 180 }, { x: 220, y: 220 }]);
    touch("touchcancel", scene, []);
    await settle();
    expect($("#reader-scene").dataset.view).toBe("grid");
    expect($("#thumbnail-grid").hidden).toBe(false);
    expect($("#thumbnail-grid").style.opacity).toBe("1");
  });

  it("ends a pinch when a third finger lands instead of resuming it later", async () => {
    await openReader();
    const scene = $("#reader-scene");
    touch("touchstart", scene, [{ x: 100, y: 100 }, { x: 300, y: 300 }]);
    touch("touchmove", scene, [{ x: 120, y: 120 }, { x: 280, y: 280 }]);
    touch("touchstart", scene, [{ x: 120, y: 120 }, { x: 280, y: 280 }, { x: 400, y: 400 }]);
    await settle();
    const settled = $("#page-track").style.transform;
    expect(settled).toContain("scale(1)");
    touch("touchmove", scene, [{ x: 50, y: 50 }, { x: 500, y: 500 }]);
    expect($("#page-track").style.transform).toBe(settled);
  });

  it("keeps a note draft through selection cancellation and saves it", async () => {
    const { internals } = await openReader();
    const geometry = { text: "Hello", rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.02 }], startHandle: { x: 0.1, y: 0.1, height: 0.02 }, endHandle: { x: 0.2, y: 0.1, height: 0.02 }, context: "Hello world", range: { start: { itemIndex: 0, offset: 0 }, end: { itemIndex: 0, offset: 5 } } };
    internals.selection = { pageNumber: 1, pageText: pageText(1), anchorStart: geometry.range.start, anchorEnd: geometry.range.end, start: geometry.range.start, end: geometry.range.end, geometry };
    $("#selection-note").click();
    expect($("#annotation-editor").hidden).toBe(false);
    expect(document.activeElement).toBe($("#annotation-text"));
    internals.selection = undefined;
    ($("#annotation-text") as HTMLTextAreaElement).value = "Remember";
    $("#annotation-save").click();
    await settle();
    expect(storage.putAnnotation).toHaveBeenCalledWith(expect.objectContaining({ kind: "note", body: "Remember", text: "Hello" }));
    expect($("#annotation-editor").hidden).toBe(true);
  });

  it("keeps the note editor open when saving fails", async () => {
    const { internals } = await openReader();
    const geometry = { text: "Hello", rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.02 }], startHandle: { x: 0.1, y: 0.1, height: 0.02 }, endHandle: { x: 0.2, y: 0.1, height: 0.02 }, context: "", range: { start: { itemIndex: 0, offset: 0 }, end: { itemIndex: 0, offset: 5 } } };
    internals.selection = { pageNumber: 1, pageText: pageText(1), anchorStart: geometry.range.start, anchorEnd: geometry.range.end, start: geometry.range.start, end: geometry.range.end, geometry };
    storage.putAnnotation.mockRejectedValueOnce(new Error("quota"));
    $("#selection-note").click();
    ($("#annotation-text") as HTMLTextAreaElement).value = "Keep me";
    $("#annotation-save").click();
    await settle();
    expect($("#annotation-editor").hidden).toBe(false);
    expect(($("#annotation-text") as HTMLTextAreaElement).value).toBe("Keep me");
    expect($("#reader-status").textContent).toContain("quota");
  });

  it("does not open Find over the note editor with Cmd+F", async () => {
    const { internals } = await openReader();
    const geometry = { text: "Hello", rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.02 }], startHandle: { x: 0, y: 0, height: 0 }, endHandle: { x: 0, y: 0, height: 0 }, context: "", range: { start: { itemIndex: 0, offset: 0 }, end: { itemIndex: 0, offset: 5 } } };
    internals.selection = { pageNumber: 1, pageText: pageText(1), anchorStart: geometry.range.start, anchorEnd: geometry.range.end, start: geometry.range.start, end: geometry.range.end, geometry };
    $("#selection-note").click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    expect($("#find-panel").hidden).toBe(true);
    expect($("#annotation-editor").hidden).toBe(false);
  });
});

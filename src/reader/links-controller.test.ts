// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { PdfDocument } from "../core/doc";
import type { PdfLink } from "../core/links";
import { LinksController } from "./links-controller";

function setup(links: PdfLink[], active = true) {
  document.body.replaceChildren();
  const layer = document.createElement("div");
  document.body.append(layer);
  const pdf = {
    pageCount: 10,
    pageLinks: () => Promise.resolve(links),
    resolveDestination: () => Promise.resolve(7)
  } as unknown as PdfDocument;
  const context = {
    currentDocument: () => pdf,
    linksActive: () => active,
    activeLayer: () => layer,
    visibleTargets: () => [{ pageNumber: 3, layout: { x: 10, y: 20, width: 600, height: 800, scale: 1 } }],
    claimInput: vi.fn(),
    goToPage: vi.fn(() => Promise.resolve()),
    openExternalUrl: vi.fn(),
    confirm: vi.fn(() => true),
    reportUnavailable: vi.fn()
  };
  const controller = new LinksController([layer], context);
  layer.addEventListener("click", (event) => controller.onActivate(event));
  return { controller, layer, context };
}

const link = (target: PdfLink["target"]): PdfLink => ({ id: "l", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 }, target });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("links controller", () => {
  it("renders aligned, labelled link buttons and follows page actions", async () => {
    const { controller, layer, context } = setup([link({ kind: "action", action: "NextPage" })]);
    await controller.refresh();
    const button = layer.querySelector<HTMLButtonElement>("button.pdf-link");
    expect(button?.style.left).toBe("70px");
    expect(button?.getAttribute("aria-label")).toBe("Go to next PDF page");
    button?.click();
    await settle();
    expect(context.claimInput).toHaveBeenCalled();
    expect(context.goToPage).toHaveBeenCalledWith(4);
  });

  it("asks before opening external links", async () => {
    const { controller, layer, context } = setup([link({ kind: "url", url: "https://example.com/" })]);
    context.confirm.mockReturnValueOnce(false);
    await controller.refresh();
    layer.querySelector<HTMLButtonElement>("button")?.click();
    expect(context.openExternalUrl).not.toHaveBeenCalled();
    layer.querySelector<HTMLButtonElement>("button")?.click();
    expect(context.openExternalUrl).toHaveBeenCalledWith("https://example.com/");
  });

  it("resolves destinations and renders nothing while inactive", async () => {
    const active = setup([link({ kind: "destination", destination: "chapter" })]);
    await active.controller.refresh();
    active.layer.querySelector<HTMLButtonElement>("button")?.click();
    await settle();
    expect(active.context.goToPage).toHaveBeenCalledWith(7);

    const inactive = setup([link({ kind: "destination", destination: "chapter" })], false);
    await inactive.controller.refresh();
    expect(inactive.layer.children).toHaveLength(0);
  });
});

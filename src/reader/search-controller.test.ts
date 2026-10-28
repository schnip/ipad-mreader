// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { PdfDocument } from "../core/doc";
import type { SearchPageText } from "../core/search";
import { SearchController } from "./search-controller";

const text = (pageNumber: number): SearchPageText => ({
  pageNumber,
  width: 600,
  height: 800,
  items: pageNumber === 2 ? [{ text: "find the needle", x: 0, y: 0, width: 150, height: 10 }] : [{ text: "hay", x: 0, y: 0, width: 30, height: 10 }]
});

function setup() {
  document.body.replaceChildren();
  const input = document.createElement("input");
  const results = document.createElement("ol");
  const summary = document.createElement("span");
  const layer = document.createElement("div");
  document.body.append(input, results, summary, layer);
  const pdf = { pageCount: 3, pageText: (page: number) => Promise.resolve(text(page)) } as unknown as PdfDocument;
  const goToPage = vi.fn(() => Promise.resolve());
  const controller = new SearchController({ input, results, summary, hitLayers: [layer] }, {
    currentDocument: () => pdf,
    visibleTargets: () => [{ pageNumber: 2, layout: { x: 0, y: 0, width: 600, height: 800, scale: 1 }, layer }],
    goToPage
  });
  return { controller, input, results, summary, layer, goToPage };
}

describe("search controller", () => {
  it("scans, lists results, jumps to the first hit, and marks it", async () => {
    const { controller, input, results, summary, layer, goToPage } = setup();
    input.value = "needle";
    await controller.run();
    expect(summary.textContent).toBe("1 matches · 3 pages scanned");
    expect(results.querySelectorAll("button[data-search-index]")).toHaveLength(1);
    expect(goToPage).toHaveBeenCalledWith(2);
    expect(layer.querySelectorAll(".search-hit.current")).toHaveLength(1);
  });

  it("clears results and marks", async () => {
    const { controller, input, results, summary, layer } = setup();
    input.value = "needle";
    await controller.run();
    controller.clear();
    expect(results.children).toHaveLength(0);
    expect(layer.children).toHaveLength(0);
    expect(summary.textContent).toBe("Enter text to search.");
    expect(controller.hitCount).toBe(0);
  });

  it("debounces typing into a single scan", async () => {
    vi.useFakeTimers();
    try {
      const { controller, input, goToPage } = setup();
      input.value = "needle";
      controller.onInput();
      controller.onInput();
      await vi.advanceTimersByTimeAsync(500);
      expect(goToPage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

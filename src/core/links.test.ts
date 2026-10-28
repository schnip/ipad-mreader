import { describe, expect, it } from "vitest";
import { extractPdfLinks, pageForPdfAction, safeExternalPdfUrl } from "./links";

const viewport = {
  width: 600,
  height: 800,
  convertToViewportRectangle: (rect: number[]) => {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = rect;
    return [x1, 800 - y1, x2, 800 - y2];
  }
};

describe("PDF link annotations", () => {
  it("normalizes viewport coordinates and preserves internal destinations", () => {
    const link = extractPdfLinks([{
      annotationType: 2,
      id: "toc-1",
      rect: [60, 720, 300, 680],
      dest: [{ num: 12, gen: 0 }, { name: "XYZ" }]
    }], 2, viewport)[0];
    expect(link).toMatchObject({
      id: "toc-1",
      target: { kind: "destination", destination: [{ num: 12, gen: 0 }, { name: "XYZ" }] }
    });
    expect(link?.rect.x).toBeCloseTo(0.1);
    expect(link?.rect.y).toBeCloseTo(0.1);
    expect(link?.rect.width).toBeCloseTo(0.4);
    expect(link?.rect.height).toBeCloseTo(0.05);
  });

  it("supports named page actions and safe external protocols", () => {
    const links = extractPdfLinks([
      { annotationType: 2, rect: [0, 100, 100, 0], action: "NextPage" },
      { annotationType: 2, rect: [100, 100, 200, 0], url: "https://example.com/read?q=1" },
      { annotationType: 2, rect: [200, 100, 300, 0], url: "mailto:reader@example.com" }
    ], 2, viewport);
    expect(links.map(({ target }) => target)).toEqual([
      { kind: "action", action: "NextPage" },
      { kind: "url", url: "https://example.com/read?q=1" },
      { kind: "url", url: "mailto:reader@example.com" }
    ]);
  });

  it("rejects unsafe URLs, unsupported actions, invalid rectangles, and non-links", () => {
    expect(extractPdfLinks([
      { annotationType: 2, rect: [0, 100, 100, 0], url: "javascript:alert(1)" },
      { annotationType: 2, rect: [0, 100, 100, 0], action: "Print" },
      { annotationType: 2, rect: [0, 0, 0, 0], dest: "chapter" },
      { annotationType: 1, rect: [0, 100, 100, 0], dest: "chapter" }
    ], 2, viewport)).toEqual([]);
    expect(safeExternalPdfUrl("file:///private/document.pdf")).toBeUndefined();
    expect(safeExternalPdfUrl("not a URL")).toBeUndefined();
  });

  it("clips rectangles to the visible page and supplies fallback identities", () => {
    expect(extractPdfLinks([{
      annotationType: 2,
      rect: [-100, 900, 700, -100],
      dest: "chapter"
    }], 2, viewport)).toEqual([{
      id: "link-0",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      target: { kind: "destination", destination: "chapter" }
    }]);
  });

  it("bounds named page actions to the document", () => {
    expect(pageForPdfAction("FirstPage", 8, 20)).toBe(1);
    expect(pageForPdfAction("LastPage", 8, 20)).toBe(20);
    expect(pageForPdfAction("NextPage", 20, 20)).toBe(20);
    expect(pageForPdfAction("PrevPage", 1, 20)).toBe(1);
    expect(pageForPdfAction("NextPage", 4, 20)).toBe(5);
  });
});

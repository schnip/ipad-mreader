import { describe, expect, it } from "vitest";
import { SearchGeneration, matchPageText, normalizeSearchText, searchContext, searchPages, transformedTextBounds } from "./search";
import type { SearchPageText } from "./search";

const page = (pageNumber: number, values: string[]): SearchPageText => ({
  pageNumber,
  width: 600,
  height: 900,
  items: values.map((text, index) => ({ text, x: index * 50, y: 20, width: 45, height: 12 }))
});

describe("document search", () => {
  it("normalizes case, whitespace, and combining marks", () => {
    expect(normalizeSearchText("  CAFÉ\n  Reader ")).toBe("cafe reader");
  });

  it("maps upright and rotated text into viewport rectangles", () => {
    expect(transformedTextBounds([10, 0, 0, 10, 20, 30], [1, 0, 0, -1, 0, 100], 40, 10)).toEqual({ x: 20, y: 60, width: 40, height: 10 });
    const rotated = transformedTextBounds([10, 0, 0, 10, 20, 30], [0, 1, 1, 0, 0, 0], 40, 10);
    expect(rotated.x).toBeCloseTo(30);
    expect(rotated.y).toBeCloseTo(20);
    expect(rotated.width).toBeCloseTo(10);
    expect(rotated.height).toBeCloseTo(40);
  });

  it("matches within and across items and retains item indexes", () => {
    expect(matchPageText(page(4, ["Clean", "Room reader", "clean"]), "clean room")[0]).toMatchObject({ pageNumber: 4, itemIndexes: [0, 1] });
    expect(matchPageText(page(4, ["uncleanly"]), "clean")[0]?.segments).toEqual([{ itemIndex: 0, startOffset: 2, endOffset: 7 }]);
    expect(matchPageText(page(4, ["Clean", "Room reader", "clean"]), "clean")).toHaveLength(2);
    expect(matchPageText(page(4, ["Clean"]), "")).toEqual([]);
  });

  it("builds bounded readable context", () => {
    expect(searchContext("0123456789abcdefghij", 8, 3, 4)).toBe("…456789abcde…");
  });

  it("reports batched progress, scanned pages, and no-text state", async () => {
    const progress: number[] = [];
    const result = await searchPages(5, "needle", async (number) => page(number, number === 3 ? ["a needle here"] : []), new SearchGeneration(), (state) => progress.push(state.scanned), 2);
    expect(progress).toEqual([2, 4, 5]);
    expect(result).toMatchObject({ scanned: 5, total: 5, textPages: 1, done: true, cancelled: false });
    expect(result.hits.map((hit) => hit.pageNumber)).toEqual([3]);
  });

  it("drops stale results when a newer query cancels a running batch", async () => {
    const generations = new SearchGeneration();
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const running = searchPages(2, "needle", async (number) => {
      await waiting;
      return page(number, ["needle"]);
    }, generations, undefined, 1);
    generations.cancel();
    release?.();
    expect(await running).toMatchObject({ cancelled: true, hits: [] });
  });

  it("caps retained contexts while preserving the exact match count", async () => {
    const result = await searchPages(3, "a", async (number) => page(number, ["a a a"]), new SearchGeneration(), undefined, 2, 2);
    expect(result.matchCount).toBe(9);
    expect(result.hits).toHaveLength(2);
  });
});

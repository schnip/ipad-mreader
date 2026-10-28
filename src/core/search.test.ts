import { describe, expect, it } from "vitest";
import { SearchGeneration, matchPageText, normalizeSearchText, searchContext, searchPages, textItemSeparator, transformedTextBounds } from "./search";
import type { SearchPageText, SearchTextItem } from "./search";

const page = (pageNumber: number, values: string[]): SearchPageText => ({
  pageNumber,
  width: 600,
  height: 900,
  items: values.map((text, index) => ({ text, x: index * 50, y: 20, width: 45, height: 12 }))
});

/** Items laid out left to right on one line with explicit gaps after each. */
const line = (values: { text: string; gapAfter?: number; endOfLine?: boolean }[]): SearchPageText => {
  let x = 0;
  const items: SearchTextItem[] = values.map(({ text, gapAfter = 0, endOfLine }) => {
    const item: SearchTextItem = { text, x, y: 20, width: text.length * 6, height: 12, ...(endOfLine ? { endOfLine } : {}) };
    x += item.width + gapAfter;
    return item;
  });
  return { pageNumber: 1, width: 600, height: 900, items };
};

describe("document search", () => {
  it("normalizes case, whitespace, and combining marks", () => {
    expect(normalizeSearchText("  CAFÉ\n  Reader ")).toBe("cafe reader");
    expect(normalizeSearchText("co\u00adoperate")).toBe("cooperate");
    expect(normalizeSearchText("\ufb01nd")).toBe("find");
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

  it("joins a word split across adjacent items without inserting a space", () => {
    const split = line([{ text: "hel" }, { text: "lo", gapAfter: 4 }, { text: "world" }]);
    expect(matchPageText(split, "hello")[0]?.segments).toEqual([
      { itemIndex: 0, startOffset: 0, endOffset: 3 },
      { itemIndex: 1, startOffset: 0, endOffset: 2 }
    ]);
    expect(matchPageText(split, "hello world")).toHaveLength(1);
    expect(matchPageText(split, "hel lo")).toHaveLength(0);
  });

  it("treats whitespace items, explicit spaces, and line ends as word breaks", () => {
    expect(matchPageText(line([{ text: "red" }, { text: " " }, { text: "fox" }]), "red fox")).toHaveLength(1);
    expect(matchPageText(line([{ text: "red " }, { text: "fox" }]), "red fox")).toHaveLength(1);
    expect(matchPageText(line([{ text: "red", endOfLine: true }, { text: "fox" }]), "red fox")).toHaveLength(1);
    expect(matchPageText(line([{ text: "red", endOfLine: true }, { text: "fox" }]), "redfox")).toHaveLength(0);
  });

  it("removes a line-end hyphen that splits a word", () => {
    const hyphenated = line([{ text: "exam-", endOfLine: true }, { text: "ple text" }]);
    const [hit] = matchPageText(hyphenated, "example");
    expect(hit?.segments).toEqual([
      { itemIndex: 0, startOffset: 0, endOffset: 4 },
      { itemIndex: 1, startOffset: 0, endOffset: 3 }
    ]);
    expect(matchPageText(line([{ text: "Self-", endOfLine: true }, { text: "Help" }]), "self- help")).toHaveLength(1);
  });

  it("decides separators from geometry and falls back to a space", () => {
    const base = { x: 0, y: 0, width: 30, height: 12 };
    expect(textItemSeparator({ ...base, text: "a" }, { ...base, x: 30.5, text: "b" }).separator).toBe("");
    expect(textItemSeparator({ ...base, text: "a" }, { ...base, x: 34, text: "b" }).separator).toBe(" ");
    expect(textItemSeparator({ ...base, text: "a" }, { ...base, x: Number.NaN, text: "b" }).separator).toBe(" ");
    const vertical = { x: 0, y: 0, width: 12, height: 30 };
    expect(textItemSeparator({ ...vertical, text: "a" }, { ...vertical, y: 30.5, text: "b" }).separator).toBe("");
  });

  it("builds bounded readable context", () => {
    expect(searchContext("0123456789abcdefghij", 8, 3, 4)).toBe("…456789abcde…");
  });

  it("reports batched progress, scanned pages, and no-text state", async () => {
    const progress: number[] = [];
    const result = await searchPages(5, "needle", (number) => Promise.resolve(page(number, number === 3 ? ["a needle here"] : [])), new SearchGeneration(), (state) => progress.push(state.scanned), 2);
    expect(progress).toEqual([2, 4, 5]);
    expect(result).toMatchObject({ scanned: 5, total: 5, textPages: 1, failedPages: 0, done: true, cancelled: false });
    expect(result.hits.map((hit) => hit.pageNumber)).toEqual([3]);
  });

  it("skips a page whose text cannot be read instead of failing the search", async () => {
    const result = await searchPages(3, "needle", (number) => (
      number === 2 ? Promise.reject(new Error("broken page")) : Promise.resolve(page(number, ["needle"]))
    ), new SearchGeneration());
    expect(result).toMatchObject({ scanned: 3, failedPages: 1, matchCount: 2, done: true });
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

  it("aborts the previous generation's signal when cancelled", async () => {
    const generations = new SearchGeneration();
    let seen: AbortSignal | undefined;
    const running = searchPages(1, "x", (number, signal) => {
      seen = signal;
      return new Promise<SearchPageText>((resolve) => signal.addEventListener("abort", () => resolve(page(number, [])), { once: true }));
    }, generations);
    generations.cancel();
    expect(seen?.aborted).toBe(true);
    expect(await running).toMatchObject({ cancelled: true });
  });

  it("caps retained contexts while preserving the exact match count", async () => {
    const result = await searchPages(3, "a", (number) => Promise.resolve(page(number, ["a a a"])), new SearchGeneration(), undefined, 2, 2);
    expect(result.matchCount).toBe(9);
    expect(result.hits).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";
import { destinationTarget, flattenOutline, outlineTreeStructure } from "./outline";

describe("PDF outline helpers", () => {
  it("flattens nested bookmarks in document order with stable paths", () => {
    const result = flattenOutline([{
      title: " Part I ",
      dest: [0],
      items: [{ title: "", dest: "chapter", items: [] }]
    }]);
    expect(result).toEqual([
      { title: "Part I", depth: 0, dest: [0], path: [0] },
      { title: "Untitled bookmark", depth: 1, dest: "chapter", path: [0, 0] }
    ]);
  });

  it("accepts page indexes and PDF references while rejecting invalid destinations", () => {
    expect(destinationTarget([3, { name: "XYZ" }])).toEqual({ kind: "index", index: 3 });
    expect(destinationTarget([{ num: 12, gen: 0 }])).toEqual({ kind: "reference", reference: { num: 12, gen: 0 } });
    expect(destinationTarget("named")).toBeUndefined();
    expect(destinationTarget([{ invalid: true }])).toBeUndefined();
  });

  it("retains nested tree structure, levels, and paths for accessible rendering", () => {
    expect(outlineTreeStructure([{
      title: " Part I ",
      dest: [0],
      items: [{ title: "", dest: "chapter", items: [] }]
    }])).toEqual([{
      title: "Part I",
      level: 1,
      dest: [0],
      path: [0],
      children: [{ title: "Untitled bookmark", level: 2, dest: "chapter", path: [0, 0], children: [] }]
    }]);
  });
});

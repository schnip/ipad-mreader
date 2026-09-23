import { describe, expect, it } from "vitest";
import { normalizeStoredAnnotations } from "./annotations";

describe("annotation persistence normalization", () => {
  const rects = [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }];

  it("normalizes records without requiring IndexedDB", () => {
    expect(normalizeStoredAnnotations([
      { kind: "highlight", id: "h", documentId: "doc", pageNumber: 2, createdAt: 4, rects, text: "hello" },
      null,
      { kind: "unknown", id: "bad", documentId: "doc", pageNumber: 1 }
    ])).toEqual([expect.objectContaining({ kind: "highlight", id: "h", updatedAt: 4 })]);
  });

  it("filters document and page scope defensively", () => {
    const records = [
      { kind: "note", id: "a", documentId: "a", pageNumber: 1, rects, body: "one" },
      { kind: "note", id: "b", documentId: "b", pageNumber: 1, rects, body: "two" },
      { kind: "note", id: "c", documentId: "a", pageNumber: 2, rects, body: "three" }
    ];
    expect(normalizeStoredAnnotations(records, "a").map(({ id }) => id)).toEqual(["a", "c"]);
    expect(normalizeStoredAnnotations(records, "a", 2).map(({ id }) => id)).toEqual(["c"]);
  });

  it("returns page/time ordered records independent of raw store order", () => {
    expect(normalizeStoredAnnotations([
      { kind: "note", id: "p2", documentId: "d", pageNumber: 2, createdAt: 1, rects },
      { kind: "note", id: "late", documentId: "d", pageNumber: 1, createdAt: 9, rects },
      { kind: "note", id: "early", documentId: "d", pageNumber: 1, createdAt: 2, rects }
    ]).map(({ id }) => id)).toEqual(["early", "late", "p2"]);
  });
});

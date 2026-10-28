import { describe, expect, it } from "vitest";
import { MAX_INK_POINTS, annotationMetadata, annotationsForPage, appendInkPoint, characterHitTest, clampPressure, createAnnotationId, inkSegments, normalizeAnnotation, normalizeTextRange, orderAnnotations, pressureStrokeWidth, selectionContainsPoint, selectionRangeGeometry } from "./annotations";
import type { InkPoint } from "./annotations";
import type { SearchPageText } from "./search";

const page: SearchPageText = {
  pageNumber: 2,
  width: 200,
  height: 100,
  items: [
    { text: "Hello", x: 20, y: 10, width: 50, height: 10 },
    { text: "world", x: 80, y: 10, width: 50, height: 10 },
    { text: "Again", x: 20, y: 30, width: 50, height: 10 }
  ]
};

describe("annotation domain", () => {
  it("creates deterministic stable IDs and metadata when entropy is supplied", () => {
    expect(createAnnotationId(1_000, 0.5)).toBe(createAnnotationId(1_000, 0.5));
    expect(annotationMetadata(" doc ", 2.4, 10, "fixed")).toEqual({ id: "fixed", documentId: "doc", pageNumber: 2, createdAt: 10, updatedAt: 10 });
  });

  it("defensively normalizes highlights and clamps rectangles", () => {
    expect(normalizeAnnotation({
      kind: "highlight", id: " h ", documentId: " doc ", pageNumber: 3.2, createdAt: 5, updatedAt: 2,
      color: "#ABCDEF", rects: [{ x: -1, y: 0.2, width: 4, height: 0.3 }], text: "selected", context: "around"
    })).toEqual({
      kind: "highlight", id: "h", documentId: "doc", pageNumber: 3, createdAt: 5, updatedAt: 5,
      color: "#abcdef", rects: [{ x: 0, y: 0.2, width: 1, height: 0.3 }], text: "selected", context: "around"
    });
  });

  it("normalizes notes and rejects identity-free or empty geometry records", () => {
    expect(normalizeAnnotation({ kind: "note", id: "n", documentId: "d", pageNumber: 1, rects: [{ x: 0, y: 0, width: 0.1, height: 0.1 }], body: "memo" })).toMatchObject({ kind: "note", body: "memo" });
    expect(normalizeAnnotation({ kind: "note", id: "", documentId: "d", pageNumber: 1, rects: [] })).toBeUndefined();
    expect(normalizeAnnotation({ kind: "highlight", id: "h", documentId: "d", pageNumber: 1, rects: [{ x: 1, y: 1, width: 0, height: 0 }] })).toBeUndefined();
  });

  it("normalizes bounded ink and rejects one-point strokes", () => {
    expect(normalizeAnnotation({ kind: "ink", id: "i", documentId: "d", pageNumber: 1, baseWidth: 99, points: [
      { x: -1, y: 2, pressure: -4, elapsed: -2 }, { x: 0.5, y: 0.5, pressure: 4, elapsed: 2 }
    ] })).toMatchObject({ kind: "ink", baseWidth: 12, points: [
      { x: 0, y: 1, pressure: 0.05, elapsed: 0 }, { x: 0.5, y: 0.5, pressure: 1, elapsed: 2 }
    ] });
    expect(normalizeAnnotation({ kind: "ink", id: "i", documentId: "d", pageNumber: 1, points: [{ x: 0, y: 0 }] })).toBeUndefined();
  });

  it("orders page-first then time and filters a page", () => {
    const values = [
      normalizeAnnotation({ kind: "note", id: "later", documentId: "d", pageNumber: 2, createdAt: 9, rects: [{ x: 0, y: 0, width: 1, height: 1 }] }),
      normalizeAnnotation({ kind: "note", id: "first", documentId: "d", pageNumber: 1, createdAt: 8, rects: [{ x: 0, y: 0, width: 1, height: 1 }] }),
      normalizeAnnotation({ kind: "note", id: "early", documentId: "d", pageNumber: 2, createdAt: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }] })
    ].filter((value) => value !== undefined);
    expect(orderAnnotations(values).map(({ id }) => id)).toEqual(["first", "early", "later"]);
    expect(annotationsForPage(values, 2).map(({ id }) => id)).toEqual(["early", "later"]);
  });
});

describe("character selection geometry", () => {
  it("hit-tests individual characters and tolerates a small outside distance", () => {
    expect(characterHitTest(page, { x: 0.175, y: 0.15 })).toEqual({ itemIndex: 0, offset: 1 });
    expect(characterHitTest(page, { x: 0.41, y: 0.15 })).toEqual({ itemIndex: 1, offset: 0 });
    expect(characterHitTest(page, { x: 0.95, y: 0.9 })).toBeUndefined();
  });

  it("normalizes reversed and corrupt ranges", () => {
    expect(normalizeTextRange(page, { itemIndex: 1, offset: 4 }, { itemIndex: 0, offset: 2 })).toEqual({
      start: { itemIndex: 0, offset: 2 }, end: { itemIndex: 1, offset: 4 }
    });
    expect(normalizeTextRange(page, { itemIndex: 99, offset: 0 }, { itemIndex: 0, offset: 1 })).toBeUndefined();
  });

  it("builds character-level normalized multi-item rectangles, handles, text, and context", () => {
    const geometry = selectionRangeGeometry(page, { itemIndex: 0, offset: 2 }, { itemIndex: 1, offset: 3 }, 2);
    expect(geometry?.rects).toHaveLength(2);
    expect(geometry?.rects[0]).toMatchObject({ x: 0.2, y: 0.1, height: 0.1 });
    expect(geometry?.rects[0]?.width).toBeCloseTo(0.15);
    expect(geometry?.rects[1]).toMatchObject({ x: 0.4, y: 0.1, height: 0.1 });
    expect(geometry?.rects[1]?.width).toBeCloseTo(0.15);
    expect(geometry?.startHandle).toEqual({ x: 0.2, y: 0.1, height: 0.1 });
    expect(geometry?.endHandle?.y).toBe(0.1);
    expect(geometry?.endHandle?.height).toBe(0.1);
    expect(geometry?.endHandle?.x).toBeCloseTo(0.55);
    expect(geometry?.text).toBe("llo wor");
    expect(geometry?.context).toContain("llo wor");
  });

  it("returns no geometry for a caret-only or empty selection", () => {
    expect(selectionRangeGeometry(page, { itemIndex: 0, offset: 2 }, { itemIndex: 0, offset: 2 })).toBeUndefined();
  });

  it("hit-tests points against the selection rectangles, handles, and pad", () => {
    const geometry = selectionRangeGeometry(page, { itemIndex: 0, offset: 2 }, { itemIndex: 1, offset: 3 }, 2);
    if (!geometry) throw new Error("expected selection geometry");
    expect(selectionContainsPoint(geometry, { x: 0.25, y: 0.15 })).toBe(true);
    expect(selectionContainsPoint(geometry, { x: 0.9, y: 0.9 })).toBe(false);
    expect(selectionContainsPoint(geometry, { x: 0.25, y: 0.205 })).toBe(false);
    expect(selectionContainsPoint(geometry, { x: 0.25, y: 0.205 }, 0.02, 0.02)).toBe(true);
    expect(selectionContainsPoint(geometry, { x: Number.NaN, y: 0.15 })).toBe(false);
  });
});

describe("ink sampling", () => {
  it("clamps pressure and derives variable widths", () => {
    expect(clampPressure(-1)).toBe(0.05);
    expect(clampPressure(4)).toBe(1);
    expect(pressureStrokeWidth(1)).toBeGreaterThan(pressureStrokeWidth(0.1));
  });

  it("coalesces nearby samples and emits variable-width segments", () => {
    let points: InkPoint[] = [];
    points = appendInkPoint(points, { x: 0, y: 0, pressure: 0.2, elapsed: 0 });
    points = appendInkPoint(points, { x: 0.0001, y: 0.0001, pressure: 0.8, elapsed: 1 });
    points = appendInkPoint(points, { x: 0.1, y: 0.1, pressure: 1, elapsed: 2 });
    expect(points).toHaveLength(2);
    expect(points[0]?.pressure).toBe(0.8);
    expect(inkSegments(points)).toHaveLength(1);
  });

  it("keeps long strokes bounded while preserving a recent endpoint", () => {
    let points: InkPoint[] = [];
    for (let index = 0; index < MAX_INK_POINTS + 100; index += 1) {
      points = appendInkPoint(points, { x: index / (MAX_INK_POINTS + 100), y: 0.5, pressure: 0.5, elapsed: index }, 0, 32);
    }
    expect(points.length).toBeLessThanOrEqual(32);
    expect(points.at(-1)?.elapsed).toBe(MAX_INK_POINTS + 99);
  });
});

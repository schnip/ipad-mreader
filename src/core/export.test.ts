import { PDFDocument, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { Annotation } from "./annotations";
import { annotatedFileName, exportAnnotatedPdf, inkThickness, noteMarkerPlacement, parseHexColor, rotateVector, winAnsiSafe, wrapTextLines } from "./export";
import { viewportMatrix, viewportSize } from "./export-geometry";

describe("annotated PDF export helpers", () => {
  it("parses exact six-digit hex colors", () => {
    const color = parseHexColor("#ffe45c");
    expect(color?.r).toBeCloseTo(1);
    expect(color?.g).toBeCloseTo(228 / 255);
    expect(color?.b).toBeCloseTo(92 / 255);
    expect(parseHexColor("#ABCDEF")).toEqual({ r: 171 / 255, g: 205 / 255, b: 239 / 255 });
    expect(parseHexColor("  #ffe45c  ")).toEqual(color);
    for (const invalid of ["red", "#fff", "", 7 as unknown as string]) expect(parseHexColor(invalid)).toBeUndefined();
  });

  it("scales and clamps exported ink thickness", () => {
    expect(inkThickness(2.2, 612, 820)).toBeCloseTo(1.64, 2);
    expect(inkThickness(0.01, 10, 820)).toBe(0.2);
    expect(inkThickness(100, 1_000, 100)).toBe(24);
    expect(inkThickness(0, 612)).toBe(0.2);
    expect(inkThickness(Number.NaN, 612)).toBe(0.2);
    expect(inkThickness(-2, 612)).toBe(0.2);
  });

  it("wraps words and hard-splits over-long words", () => {
    expect(wrapTextLines("one two three", 7, (value) => value.length)).toEqual(["one two", "three"]);
    expect(wrapTextLines("abcdefgh", 3, (value) => value.length)).toEqual(["abc", "def", "gh"]);
    expect(wrapTextLines("  \n \t ", 10, (value) => value.length)).toEqual([]);
    expect(wrapTextLines("still terminates", 0.0001, () => 0)).toEqual(["still terminates"]);
  });

  it("makes arbitrary text safe for WinAnsi standard fonts", () => {
    expect(winAnsiSafe("emoji 😀 and CJK 漢")).toBe("emoji ? and CJK ?");
    expect(winAnsiSafe("‘single’ “double” – — …")).toBe("'single' \"double\" - - ...");
    expect(winAnsiSafe("line\nnext\tcolumn\rreturn")).toBe("line next column return");
    expect(winAnsiSafe("plain ASCII")).toBe("plain ASCII");
    expect(winAnsiSafe("café")).toBe("café");
  });

  it("creates safe annotated-copy file names", () => {
    expect(annotatedFileName("Report.pdf")).toBe("Report annotated.pdf");
    expect(annotatedFileName("Report")).toBe("Report annotated.pdf");
    expect(annotatedFileName("  ")).toBe("annotated.pdf");
    expect(annotatedFileName("folder/subfolder/Report.pdf")).toBe("Report annotated.pdf");
  });
});

describe("annotated PDF export", () => {
  it("burns highlights, note markers, ink, and a note summary into a copy", async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    source.addPage([400, 600]);
    const input = await source.save();
    const annotations: Annotation[] = [
      {
        kind: "highlight", id: "highlight", documentId: "document", pageNumber: 1, createdAt: 1, updatedAt: 1,
        color: "#ffe45c", rects: [{ x: 0.1, y: 0.1, width: 0.25, height: 0.04 }], text: "highlighted", context: ""
      },
      {
        kind: "note", id: "note", documentId: "document", pageNumber: 2, createdAt: 2, updatedAt: 2,
        color: "#ffb347", rects: [{ x: 0.2, y: 0.2, width: 0.3, height: 0.05 }], text: "selected text", context: "", body: "Remember this note. 😀 漢"
      },
      {
        kind: "ink", id: "ink", documentId: "document", pageNumber: 1, createdAt: 3, updatedAt: 3,
        color: "#d92d3f", baseWidth: 2.2, points: [
          { x: 0.1, y: 0.5, pressure: 0.2, elapsed: 0 },
          { x: 0.3, y: 0.55, pressure: 0.6, elapsed: 10 },
          { x: 0.5, y: 0.45, pressure: 1, elapsed: 20 }
        ]
      }
    ];

    const result = await exportAnnotatedPdf(input, annotations, "Report.pdf");
    expect(new TextDecoder().decode(result.bytes.slice(0, 4))).toBe("%PDF");
    expect(result.bytes.length).toBeGreaterThan(input.length);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(3);
    expect(result.noteCount).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("counts an out-of-range annotation and still creates a loadable PDF", async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    const input = await source.save();
    const annotation: Annotation = {
      kind: "highlight", id: "missing-page", documentId: "document", pageNumber: 5, createdAt: 1, updatedAt: 1,
      color: "#ffe45c", rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }], text: "", context: ""
    };
    const result = await exportAnnotatedPdf(input, [annotation], "Report.pdf");
    expect(result.skipped).toBe(1);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(1);
  });

  it("exports onto rotated pages with an offset crop box", async () => {
    const source = await PDFDocument.create();
    for (const angle of [0, 90, 180, 270]) {
      const page = source.addPage([612, 792]);
      page.setRotation(degrees(angle));
      page.setCropBox(20, 30, 500, 700);
    }
    const input = await source.save();
    const annotations: Annotation[] = [1, 2, 3, 4].map((pageNumber) => ({
      kind: "note", id: `note-${pageNumber}`, documentId: "document", pageNumber, createdAt: pageNumber, updatedAt: pageNumber,
      color: "#ffb347", rects: [{ x: 0.2, y: 0.2, width: 0.3, height: 0.05 }], text: "selected", context: "", body: `Note ${pageNumber}`
    }));
    const result = await exportAnnotatedPdf(input, annotations, "Rotated.pdf");
    expect(result.skipped).toBe(0);
    expect(result.noteCount).toBe(4);
    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(5);
    expect(output.getPages().slice(0, 4).map((page) => page.getRotation().angle)).toEqual([0, 90, 180, 270]);
  });
});

describe("note marker placement", () => {
  const box = { x1: 0, y1: 0, x2: 600, y2: 800 };
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };

  it("uses the displayed top-right corner of the last rectangle", () => {
    expect(noteMarkerPlacement(box, 0, rect)).toEqual({ center: { x: 240, y: 640 }, textRotation: 0 });
    for (const rotation of [90, 180, 270]) {
      const placement = noteMarkerPlacement(box, rotation, rect);
      if (!placement) throw new Error("Expected a marker placement.");
      const [a, b, c, d, e, f] = viewportMatrix(box, rotation);
      const size = viewportSize(box, rotation);
      const view = { x: a * placement.center.x + c * placement.center.y + e, y: b * placement.center.x + d * placement.center.y + f };
      expect(view.x / size.width).toBeCloseTo(0.4);
      expect(view.y / size.height).toBeCloseTo(0.2);
      expect(placement.textRotation).toBe(rotation);
    }
  });

  it("rotates text offsets counter-clockwise", () => {
    expect(rotateVector({ x: 1, y: 0 }, 90)).toEqual({ x: 0, y: 1 });
    expect(rotateVector({ x: 1, y: 2 }, 180)).toEqual({ x: -1, y: -2 });
    expect(rotateVector({ x: 1, y: 0 }, 270)).toEqual({ x: 0, y: -1 });
  });
});

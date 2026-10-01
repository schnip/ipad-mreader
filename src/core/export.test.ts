import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { Annotation } from "./annotations";
import { annotatedFileName, exportAnnotatedPdf, inkThickness, parseHexColor, winAnsiSafe, wrapTextLines } from "./export";

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
});

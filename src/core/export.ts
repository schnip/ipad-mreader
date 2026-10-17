import type { PDFFont, PDFPage } from "pdf-lib";
import { annotationsForPage, inkSegments, orderAnnotations } from "./annotations";
import type { Annotation, NormalizedRect, NoteAnnotation } from "./annotations";
import { normalizeRotation, userPointFromNormalized, userRectFromNormalized, viewportSize } from "./export-geometry";
import type { UserPoint, ViewBox } from "./export-geometry";

/**
 * Ink `baseWidth` was authored in CSS pixels against the iPad Air 5 portrait
 * viewport, and no authoring width is stored per stroke, so export scales
 * stroke width by the ratio of the PDF page's user-space width to this assumed
 * width. It is an approximation pending a device check.
 */
export const AUTHORING_VIEWPORT_WIDTH = 820;

export interface ExportedPdf {
  bytes: Uint8Array;
  fileName: string;
  noteCount: number;
  skipped: number;
}

export function winAnsiSafe(value: string): string {
  const mapped = value
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, "\"")
    .replace(/[\u2013\u2014]/gu, "-")
    .replace(/\u2026/gu, "...")
    .replace(/[\u00a0\u202f]/gu, " ")
    .replace(/\u00ad/gu, "")
    .replace(/[\n\r\t]/gu, " ");
  return [...mapped].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa1 && codePoint <= 0xff) ? character : "?";
  }).join("");
}

export function parseHexColor(value: string): { r: number; g: number; b: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value.trim());
  if (!match) return undefined;
  const [, red, green, blue] = match;
  if (!red || !green || !blue) return undefined;
  return { r: Number.parseInt(red, 16) / 255, g: Number.parseInt(green, 16) / 255, b: Number.parseInt(blue, 16) / 255 };
}

export function inkThickness(cssWidth: number, userPageWidth: number, authoringWidth = AUTHORING_VIEWPORT_WIDTH): number {
  if (![cssWidth, userPageWidth, authoringWidth].every((value) => Number.isFinite(value) && value > 0)) return 0.2;
  return Math.min(24, Math.max(0.2, cssWidth * userPageWidth / authoringWidth));
}

export function wrapTextLines(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  if (typeof text !== "string") return [];
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  const width = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 0;
  const lines: string[] = [];
  let line = "";

  const hardSplit = (word: string): string[] => {
    const chunks: string[] = [];
    let start = 0;
    while (start < word.length) {
      let end = start + 1;
      while (end < word.length && measure(word.slice(start, end + 1)) <= width) end += 1;
      chunks.push(word.slice(start, end));
      start = end;
    }
    return chunks;
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    if (measure(word) <= width) {
      line = word;
      continue;
    }
    const chunks = hardSplit(word);
    lines.push(...chunks.slice(0, -1));
    line = chunks.at(-1) ?? "";
  }
  if (line) lines.push(line);
  return lines;
}

export function annotatedFileName(name: string): string {
  const leaf = typeof name === "string" ? name.trim().split(/[\\/]/u).filter(Boolean).at(-1)?.trim() ?? "" : "";
  if (!leaf) return "annotated.pdf";
  return /\.pdf$/iu.test(leaf) ? `${leaf.slice(0, -4)} annotated.pdf` : `${leaf} annotated.pdf`;
}

export interface NoteMarkerPlacement {
  /** Marker centre in PDF user space. */
  center: UserPoint;
  /** Counter-clockwise text rotation in degrees so the number reads upright. */
  textRotation: number;
}

/**
 * A note's numbered marker sits at the visual top-right corner of its last
 * rectangle, as the page is displayed. Pages with /Rotate are displayed
 * rotated clockwise, so the corner is chosen in normalized view space and the
 * number is counter-rotated by the same angle.
 */
export function noteMarkerPlacement(box: ViewBox, rotation: number, lastRect: NormalizedRect): NoteMarkerPlacement | undefined {
  const center = userPointFromNormalized(box, rotation, { x: lastRect.x + lastRect.width, y: lastRect.y });
  return center ? { center, textRotation: normalizeRotation(rotation) } : undefined;
}

/** Rotates a vector counter-clockwise by `degreesCcw`. */
export function rotateVector(vector: UserPoint, degreesCcw: number): UserPoint {
  const radians = degreesCcw * Math.PI / 180;
  const cos = Math.round(Math.cos(radians) * 1e12) / 1e12;
  const sin = Math.round(Math.sin(radians) * 1e12) / 1e12;
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
}

export async function exportAnnotatedPdf(bytes: Uint8Array, annotations: readonly Annotation[], documentName: string): Promise<ExportedPdf> {
  const { BlendMode, PDFDocument, StandardFonts, LineCapStyle, degrees, rgb } = await import("pdf-lib");
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (/encrypt/iu.test(detail)) throw new Error("This PDF is protected, so an annotated copy cannot be created.", { cause: error });
    throw new Error(`Unable to read this PDF for export: ${detail}`, { cause: error });
  }

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const summaryNotes = orderAnnotations(annotations).filter((annotation): annotation is NoteAnnotation => (
    annotation.kind === "note" && Boolean(annotation.body.trim() || annotation.text.trim())
  ));
  const noteNumbers = new Map(summaryNotes.map((annotation, index) => [annotation, index + 1]));
  let skipped = annotations.filter((annotation) => (
    !Number.isInteger(annotation.pageNumber) || annotation.pageNumber < 1 || annotation.pageNumber > pages.length
  )).length;

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!page) continue;
    const crop = page.getCropBox();
    // PDF.js uses the CropBox/MediaBox intersection, so unusual box combinations could differ slightly.
    const viewBox = { x1: crop.x, y1: crop.y, x2: crop.x + crop.width, y2: crop.y + crop.height };
    const rotation = page.getRotation().angle;
    for (const annotation of annotationsForPage(annotations, index + 1)) {
      const parsedColor = parseHexColor(annotation.color);
      const color = rgb(parsedColor?.r ?? 0, parsedColor?.g ?? 0, parsedColor?.b ?? 0);
      let placed = false;
      if (annotation.kind === "highlight" || annotation.kind === "note") {
        let lastRect: NormalizedRect | undefined;
        for (const rect of annotation.rects) {
          const mapped = userRectFromNormalized(viewBox, rotation, rect);
          if (!mapped || mapped.width <= 0 || mapped.height <= 0) continue;
          // Multiply matches the in-app tint over white paper but keeps the
          // underlying text dark instead of washing it toward the highlight colour.
          page.drawRectangle({ ...mapped, color, opacity: annotation.kind === "highlight" ? 0.38 : 0.3, blendMode: BlendMode.Multiply });
          lastRect = rect;
          placed = true;
        }
        const noteNumber = annotation.kind === "note" ? noteNumbers.get(annotation) : undefined;
        const placement = lastRect ? noteMarkerPlacement(viewBox, rotation, lastRect) : undefined;
        if (annotation.kind === "note" && noteNumber !== undefined && placement) {
          const marker = winAnsiSafe(String(noteNumber));
          const markerSize = 8;
          page.drawCircle({ x: placement.center.x, y: placement.center.y, size: 7, color });
          const origin = rotateVector(
            { x: -bold.widthOfTextAtSize(marker, markerSize) / 2, y: -bold.heightAtSize(markerSize) / 2 },
            placement.textRotation
          );
          page.drawText(marker, {
            x: placement.center.x + origin.x,
            y: placement.center.y + origin.y,
            size: markerSize,
            font: bold,
            color: rgb(1, 1, 1),
            rotate: degrees(placement.textRotation)
          });
        }
      } else {
        for (const segment of inkSegments(annotation.points, annotation.baseWidth)) {
          const start = userPointFromNormalized(viewBox, rotation, segment.from);
          const end = userPointFromNormalized(viewBox, rotation, segment.to);
          if (!start || !end) continue;
          page.drawLine({
            start,
            end,
            // Stroke width must scale against the rotated view width it was authored against.
            thickness: inkThickness(segment.width, viewportSize(viewBox, rotation).width),
            color,
            lineCap: LineCapStyle.Round
          });
          placed = true;
        }
      }
      if (!placed) skipped += 1;
    }
  }

  if (summaryNotes.length > 0) {
    const firstCrop = pages[0]?.getCropBox();
    const pageWidth = firstCrop && firstCrop.width > 0 ? firstCrop.width : 612;
    const pageHeight = firstCrop && firstCrop.height > 0 ? firstCrop.height : 792;
    drawNoteSummary(pdf.addPage([pageWidth, pageHeight]), true, summaryNotes, documentName, regular, bold, () => pdf.addPage([pageWidth, pageHeight]));
  }

  return {
    bytes: await pdf.save(),
    fileName: annotatedFileName(documentName),
    noteCount: summaryNotes.length,
    skipped
  };
}

function drawNoteSummary(
  firstPage: PDFPage,
  includeTitle: boolean,
  notes: readonly NoteAnnotation[],
  documentName: string,
  regular: PDFFont,
  bold: PDFFont,
  addPage: () => PDFPage
): void {
  const margin = 54;
  let page = firstPage;
  let cursor = page.getHeight() - margin;
  const availableWidth = Math.max(0, page.getWidth() - margin * 2);

  const line = (text: string, font: PDFFont, size: number): void => {
    const advance = Math.max(font.heightAtSize(size), size) + 3;
    if (cursor - advance < margin) {
      page = addPage();
      cursor = page.getHeight() - margin;
    }
    cursor -= Math.max(font.heightAtSize(size), size);
    page.drawText(text, { x: margin, y: cursor, size, font });
    cursor -= 3;
  };

  const gap = (height: number): void => {
    if (cursor - height < margin) {
      page = addPage();
      cursor = page.getHeight() - margin;
    } else {
      cursor -= height;
    }
  };

  if (includeTitle) {
    line(winAnsiSafe("Notes"), bold, 16);
    line(winAnsiSafe(documentName.trim() || "PDF"), regular, 10);
    gap(10);
  }

  notes.forEach((note, index) => {
    line(winAnsiSafe(`${index + 1}. Page ${note.pageNumber}`), bold, 10);
    const selected = winAnsiSafe(note.text.trim());
    if (selected) {
      for (const value of wrapTextLines(winAnsiSafe(`\"${selected}\"`), availableWidth, (text) => regular.widthOfTextAtSize(text, 9))) {
        line(value, regular, 9);
      }
    }
    const body = winAnsiSafe(note.body.trim());
    if (body) {
      for (const value of wrapTextLines(body, availableWidth, (text) => regular.widthOfTextAtSize(text, 10))) {
        line(value, regular, 10);
      }
    }
    gap(12);
  });
}

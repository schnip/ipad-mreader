export interface PdfLinkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PdfLinkAction = "FirstPage" | "LastPage" | "NextPage" | "PrevPage";

export type PdfLinkTarget =
  | { kind: "destination"; destination: string | unknown[] }
  | { kind: "action"; action: PdfLinkAction }
  | { kind: "url"; url: string };

export interface PdfLink {
  id: string;
  rect: PdfLinkRect;
  target: PdfLinkTarget;
}

export interface PdfLinkViewport {
  width: number;
  height: number;
  convertToViewportRectangle(rect: number[]): number[];
}

const LINK_ACTIONS = new Set<PdfLinkAction>(["FirstPage", "LastPage", "NextPage", "PrevPage"]);
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export function extractPdfLinks(
  annotations: readonly unknown[],
  linkAnnotationType: number,
  viewport: PdfLinkViewport
): PdfLink[] {
  const links: PdfLink[] = [];
  annotations.forEach((annotation, index) => {
    if (!isRecord(annotation) || annotation.annotationType !== linkAnnotationType) return;
    const rect = normalizedLinkRect(annotation.rect, viewport);
    const target = pdfLinkTarget(annotation);
    if (!rect || !target) return;
    links.push({
      id: typeof annotation.id === "string" && annotation.id ? annotation.id : `link-${index}`,
      rect,
      target
    });
  });
  return links;
}

export function safeExternalPdfUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function pageForPdfAction(action: PdfLinkAction, sourcePage: number, pageCount: number): number {
  const count = Math.max(1, Math.floor(pageCount));
  const source = Math.min(count, Math.max(1, Math.floor(sourcePage)));
  if (action === "FirstPage") return 1;
  if (action === "LastPage") return count;
  return Math.min(count, Math.max(1, source + (action === "NextPage" ? 1 : -1)));
}

function pdfLinkTarget(annotation: Record<string, unknown>): PdfLinkTarget | undefined {
  if (typeof annotation.dest === "string" || Array.isArray(annotation.dest)) {
    return { kind: "destination", destination: annotation.dest };
  }
  if (typeof annotation.action === "string" && LINK_ACTIONS.has(annotation.action as PdfLinkAction)) {
    return { kind: "action", action: annotation.action as PdfLinkAction };
  }
  const url = safeExternalPdfUrl(annotation.url);
  return url ? { kind: "url", url } : undefined;
}

function normalizedLinkRect(value: unknown, viewport: PdfLinkViewport): PdfLinkRect | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
    return undefined;
  }
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) return undefined;
  try {
    const converted = viewport.convertToViewportRectangle(value);
    if (!Array.isArray(converted) || converted.length !== 4 || !converted.every(Number.isFinite)) return undefined;
    const left = clamp(Math.min(converted[0] ?? 0, converted[2] ?? 0) / viewport.width);
    const right = clamp(Math.max(converted[0] ?? 0, converted[2] ?? 0) / viewport.width);
    const top = clamp(Math.min(converted[1] ?? 0, converted[3] ?? 0) / viewport.height);
    const bottom = clamp(Math.max(converted[1] ?? 0, converted[3] ?? 0) / viewport.height);
    if (right <= left || bottom <= top) return undefined;
    return { x: left, y: top, width: right - left, height: bottom - top };
  } catch {
    return undefined;
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pure geometry for burning sidecar annotations into a new PDF.
 *
 * Stored annotation rectangles, points, and ink samples are normalized to the
 * PDF.js view box: the cropped, rotated page that `getViewport({ scale: 1 })`
 * presents, with a top-left origin and y increasing downward. A PDF content
 * stream instead draws in unrotated user space with a bottom-left origin and a
 * possibly non-zero box origin. Export therefore has to invert exactly the
 * transform PDF.js applied, so the matrix here mirrors PDF.js's PageViewport
 * construction at scale 1 rather than re-deriving the four rotation cases.
 */

export interface ViewBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface UserPoint {
  x: number;
  y: number;
}

export interface UserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewSize {
  width: number;
  height: number;
}

export type ViewMatrix = readonly [number, number, number, number, number, number];

export function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  if (!Number.isFinite(rotation)) return 0;
  const quarter = Math.round(rotation / 90) * 90;
  const wrapped = ((quarter % 360) + 360) % 360;
  return wrapped === 90 || wrapped === 180 || wrapped === 270 ? wrapped : 0;
}

/** Size of the rotated view box, matching `getViewport({ scale: 1 })`. */
export function viewportSize(box: ViewBox, rotation: number): ViewSize {
  const width = Math.abs(box.x2 - box.x1);
  const height = Math.abs(box.y2 - box.y1);
  const angle = normalizeRotation(rotation);
  return angle === 90 || angle === 270 ? { width: height, height: width } : { width, height };
}

/** PDF.js view transform at scale 1: user space in, view space out. */
export function viewportMatrix(box: ViewBox, rotation: number): ViewMatrix {
  const angle = normalizeRotation(rotation);
  const centerX = (box.x1 + box.x2) / 2;
  const centerY = (box.y1 + box.y2) / 2;
  const rotated = angle === 90
    ? [0, 1, 1, 0]
    : angle === 180
      ? [-1, 0, 0, 1]
      : angle === 270
        ? [0, -1, -1, 0]
        : [1, 0, 0, -1];
  const [a, b, c, d] = rotated as [number, number, number, number];
  const offsetX = a === 0 ? Math.abs(centerY - box.y1) : Math.abs(centerX - box.x1);
  const offsetY = a === 0 ? Math.abs(centerX - box.x1) : Math.abs(centerY - box.y1);
  return [a, b, c, d, offsetX - a * centerX - c * centerY, offsetY - b * centerX - d * centerY];
}

/** Inverts the view transform for a single point. */
export function userPointFromView(matrix: ViewMatrix, view: UserPoint): UserPoint | undefined {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) return undefined;
  if (!Number.isFinite(view.x) || !Number.isFinite(view.y)) return undefined;
  const x = view.x - e;
  const y = view.y - f;
  return { x: (x * d - y * c) / determinant, y: (y * a - x * b) / determinant };
}

/**
 * Inverts the view transform for a rectangle. Under 90/270 rotation the width
 * and height swap, so all four corners are mapped and the bounding box taken.
 */
export function userRectFromView(matrix: ViewMatrix, rect: UserRect): UserRect | undefined {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height }
  ].map((corner) => userPointFromView(matrix, corner))
    .filter((corner): corner is UserPoint => corner !== undefined);
  if (corners.length !== 4) return undefined;
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const left = Math.min(...xs);
  const bottom = Math.min(...ys);
  return { x: left, y: bottom, width: Math.max(...xs) - left, height: Math.max(...ys) - bottom };
}

export function userPointFromNormalized(box: ViewBox, rotation: number, point: UserPoint): UserPoint | undefined {
  const size = viewportSize(box, rotation);
  return userPointFromView(viewportMatrix(box, rotation), { x: point.x * size.width, y: point.y * size.height });
}

export function userRectFromNormalized(box: ViewBox, rotation: number, rect: UserRect): UserRect | undefined {
  const size = viewportSize(box, rotation);
  return userRectFromView(viewportMatrix(box, rotation), {
    x: rect.x * size.width,
    y: rect.y * size.height,
    width: rect.width * size.width,
    height: rect.height * size.height
  });
}

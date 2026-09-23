import type { Insets, PageLayout, Size } from "./layout";

export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export const MIN_CAMERA_SCALE = 1;
export const MAX_CAMERA_SCALE = 6;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function sceneToScreen(point: Point, camera: Camera): Point {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}

export function screenToScene(point: Point, camera: Camera): Point {
  const scale = Math.max(camera.scale, Number.EPSILON);
  return { x: (point.x - camera.x) / scale, y: (point.y - camera.y) / scale };
}

export function zoomCameraAt(initial: Camera, requestedScale: number, screenPoint: Point): Camera {
  const scale = clamp(requestedScale, MIN_CAMERA_SCALE, MAX_CAMERA_SCALE);
  const scenePoint = screenToScene(screenPoint, initial);
  return {
    scale,
    x: screenPoint.x - scenePoint.x * scale,
    y: screenPoint.y - scenePoint.y * scale
  };
}

export function moveCamera(camera: Camera, delta: Point): Camera {
  return { ...camera, x: camera.x + delta.x, y: camera.y + delta.y };
}

export function constrainCamera(
  camera: Camera,
  page: PageLayout,
  viewport: Size,
  insets: Partial<Insets> = {},
  margin = 16
): Camera {
  const scale = clamp(camera.scale, MIN_CAMERA_SCALE, MAX_CAMERA_SCALE);
  return {
    scale,
    x: constrainAxis(camera.x, page.x, page.width, scale, insets.left ?? 0, insets.right ?? 0, viewport.width, margin),
    y: constrainAxis(camera.y, page.y, page.height, scale, insets.top ?? 0, insets.bottom ?? 0, viewport.height, margin)
  };
}

export function cameraForPagePoint(pagePoint: Point, screenPoint: Point, scale: number): Camera {
  const boundedScale = clamp(scale, MIN_CAMERA_SCALE, MAX_CAMERA_SCALE);
  return {
    scale: boundedScale,
    x: screenPoint.x - pagePoint.x * boundedScale,
    y: screenPoint.y - pagePoint.y * boundedScale
  };
}

export function normalizedPageCenter(camera: Camera, page: PageLayout, viewport: Size): Point {
  const center = screenToScene({ x: viewport.width / 2, y: viewport.height / 2 }, camera);
  return {
    x: clamp((center.x - page.x) / Math.max(page.width, 1), 0, 1),
    y: clamp((center.y - page.y) / Math.max(page.height, 1), 0, 1)
  };
}

function constrainAxis(
  offset: number,
  origin: number,
  extent: number,
  scale: number,
  leadingInset: number,
  trailingInset: number,
  viewportExtent: number,
  margin: number
): number {
  const availableStart = leadingInset + margin;
  const availableEnd = viewportExtent - trailingInset - margin;
  const scaledExtent = extent * scale;
  if (scaledExtent <= availableEnd - availableStart) {
    return (availableStart + availableEnd - scaledExtent) / 2 - origin * scale;
  }
  const minimum = availableEnd - (origin + extent) * scale;
  const maximum = availableStart - origin * scale;
  return clamp(offset, minimum, maximum);
}

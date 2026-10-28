/** Small shared numeric and value guards used across the pure core modules. */

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** A strictly positive finite number, or 1 for anything else. */
export function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** `value` when it is a finite number, otherwise `fallback`. */
export function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `name` of an Error or DOMException, or "" for anything else. */
export function errorName(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.name : "";
}

/** Compact human-readable byte count, e.g. "12 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? "TB"}`;
}

/** Whether an error is pdf.js's cancellation of a render task. */
export function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

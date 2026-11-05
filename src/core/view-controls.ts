import type { SemanticViewMode } from "./semantic";

export type ViewControl = "page" | "grid";

export function viewModeForControl(control: ViewControl): SemanticViewMode {
  return control === "grid" ? "grid" : "reading";
}

export function isViewControlActive(mode: SemanticViewMode, control: ViewControl): boolean {
  return mode === viewModeForControl(control);
}

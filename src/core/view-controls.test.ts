import { describe, expect, it } from "vitest";
import { isViewControlActive, viewModeForControl } from "./view-controls";

describe("view controls", () => {
  it("maps Page and Grid to the existing semantic modes", () => {
    expect(viewModeForControl("page")).toBe("reading");
    expect(viewModeForControl("grid")).toBe("grid");
  });

  it("reports exactly one active view control", () => {
    expect(isViewControlActive("reading", "page")).toBe(true);
    expect(isViewControlActive("reading", "grid")).toBe(false);
    expect(isViewControlActive("grid", "grid")).toBe(true);
  });
});

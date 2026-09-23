import { describe, expect, it } from "vitest";
import { decideReadingTap, isCenterRegion, panelScrollTop, readingTapRegion, stepPanelMomentum, suppressReaderShortcutWhileTyping } from "./chrome";

const viewport = { width: 800, height: 600 };

describe("reading chrome tap decisions", () => {
  it("uses a generous but still bounded center region", () => {
    expect(isCenterRegion({ x: 400, y: 300 }, viewport)).toBe(true);
    expect(isCenterRegion({ x: 130, y: 300 }, viewport)).toBe(true);
    expect(isCenterRegion({ x: 119, y: 300 }, viewport)).toBe(false);
    expect(isCenterRegion({ x: 400, y: 511 }, viewport)).toBe(false);
  });

  it("reserves the left and right edges for page navigation", () => {
    expect(readingTapRegion({ x: 80, y: 300 }, viewport)).toBe("previous-page");
    expect(readingTapRegion({ x: 720, y: 300 }, viewport)).toBe("next-page");
    expect(readingTapRegion({ x: 400, y: 300 }, viewport)).toBe("center");
    expect(readingTapRegion({ x: 200, y: 20 }, viewport)).toBe("none");
  });

  it("defers a center single tap so chrome cannot flash before a double tap", () => {
    expect(decideReadingTap(undefined, { at: 100, point: { x: 400, y: 300 } }, viewport)).toEqual({
      action: "defer-chrome",
      cancelPending: false
    });
  });

  it("cancels the pending toggle when the second tap makes a double tap", () => {
    const previous = { at: 100, point: { x: 400, y: 300 } };
    expect(decideReadingTap(previous, { at: 300, point: { x: 410, y: 305 } }, viewport)).toEqual({
      action: "double-tap",
      cancelPending: true
    });
  });

  it("replaces an incompatible pending tap without treating it as a double tap", () => {
    const previous = { at: 100, point: { x: 400, y: 300 } };
    expect(decideReadingTap(previous, { at: 200, point: { x: 200, y: 50 } }, viewport)).toEqual({
      action: "remember",
      cancelPending: true
    });
  });

  it("defers edge navigation through the double-tap interval", () => {
    expect(decideReadingTap(undefined, { at: 100, point: { x: 30, y: 300 } }, viewport)).toEqual({
      action: "defer-previous-page",
      cancelPending: false
    });
    expect(decideReadingTap(undefined, { at: 100, point: { x: 770, y: 300 } }, viewport)).toEqual({
      action: "defer-next-page",
      cancelPending: false
    });
  });

  it("suppresses every reader shortcut while typing except Escape and the Find chord", () => {
    for (const key of ["o", "f", "0", "ArrowLeft", "ArrowRight"]) {
      expect(suppressReaderShortcutWhileTyping({ key, typing: true })).toBe(true);
    }
    expect(suppressReaderShortcutWhileTyping({ key: "Escape", typing: true })).toBe(false);
    expect(suppressReaderShortcutWhileTyping({ key: "f", metaKey: true, typing: true })).toBe(false);
    expect(suppressReaderShortcutWhileTyping({ key: "o", typing: false })).toBe(false);
  });

  it("constrains dedicated panel drag scrolling to its content bounds", () => {
    expect(panelScrollTop(100, -40, 1000, 400)).toBe(140);
    expect(panelScrollTop(10, 80, 1000, 400)).toBe(0);
    expect(panelScrollTop(590, -80, 1000, 400)).toBe(600);
    expect(panelScrollTop(40, -20, 300, 400)).toBe(0);
  });

  it("advances panel inertia, decays velocity, and stops at content bounds", () => {
    const moving = stepPanelMomentum(200, 1.5, 16, 1200, 400);
    expect(moving.scrollTop).toBeGreaterThan(200);
    expect(moving.velocity).toBeLessThan(1.5);
    expect(moving.reachedBoundary).toBe(false);
    expect(stepPanelMomentum(795, 2, 16, 1200, 400).reachedBoundary).toBe(true);
  });
});

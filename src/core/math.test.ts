import { describe, expect, it } from "vitest";
import { errorName, formatBytes, positive, finite } from "./math";
import { externalLinkLabel, pageActionLabel } from "./links";

describe("shared helpers", () => {
  it("formats byte counts compactly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("guards numbers and error names", () => {
    expect(positive(-2)).toBe(1);
    expect(positive(3)).toBe(3);
    expect(finite("1", 7)).toBe(7);
    expect(errorName(new DOMException("x", "AbortError"))).toBe("AbortError");
    expect(errorName("nope")).toBe("");
  });

  it("labels PDF link actions and external destinations", () => {
    expect(pageActionLabel("FirstPage")).toBe("Go to first PDF page");
    expect(pageActionLabel("PrevPage")).toBe("Go to previous PDF page");
    expect(externalLinkLabel("https://example.com/path")).toBe("example.com");
    expect(externalLinkLabel("mailto:someone@example.com")).toBe("mailto");
    expect(externalLinkLabel("not a url")).toBe("external destination");
  });
});

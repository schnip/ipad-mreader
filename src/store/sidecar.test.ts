import { describe, expect, it } from "vitest";
import { dedupeRecentDocuments, defaultReadingPosition, deserializeReadingPosition, normalizeDocumentSidecar, normalizeReadingPosition, serializeReadingPosition } from "./sidecar";

describe("sidecar serialization", () => {
  it("provides a stable fit-page default", () => {
    expect(defaultReadingPosition()).toEqual({
      version: 1,
      page: 1,
      fit: "page",
      scale: 1,
      centerX: 0.5,
      centerY: 0.5
    });
  });

  it("round-trips a normalized camera position", () => {
    const position = { version: 1 as const, page: 17, fit: "custom" as const, scale: 3.25, centerX: 0.2, centerY: 0.8 };
    expect(deserializeReadingPosition(serializeReadingPosition(position), 100)).toEqual(position);
  });

  it("clamps corrupt and out-of-range fields", () => {
    expect(normalizeReadingPosition({ page: 999, fit: "other", scale: 20, centerX: -4, centerY: 7 }, 12)).toEqual({
      version: 1,
      page: 12,
      fit: "page",
      scale: 6,
      centerX: 0,
      centerY: 1
    });
  });

  it("falls back safely for malformed JSON and values", () => {
    expect(deserializeReadingPosition("{" )).toEqual(defaultReadingPosition());
    expect(normalizeReadingPosition(null)).toEqual(defaultReadingPosition());
  });

  it("normalizes document metadata and rejects records without identity", () => {
    expect(normalizeDocumentSidecar({ id: "abc", name: "Book.pdf", byteLength: 42, pageCount: 2, importedAt: 1, lastOpenedAt: 2, position: { page: 2 } })).toEqual({
      id: "abc",
      name: "Book.pdf",
      byteLength: 42,
      pageCount: 2,
      importedAt: 1,
      lastOpenedAt: 2,
      position: { version: 1, page: 2, fit: "page", scale: 1, centerX: 0.5, centerY: 0.5 }
    });
    expect(normalizeDocumentSidecar({ name: "Book.pdf" })).toBeUndefined();
  });

  it("persists valid P4 layouts while legacy and invalid values remain single", () => {
    expect(normalizeReadingPosition({ page: 3, layout: "twoUpCover" }, 10).layout).toBe("twoUpCover");
    expect(normalizeReadingPosition({ page: 3, layout: "continuous" }, 10).layout).toBe("continuous");
    expect(normalizeReadingPosition({ page: 3, layout: "bogus" }, 10).layout).toBeUndefined();
    expect(defaultReadingPosition().layout).toBeUndefined();
  });

  it("preserves optional fingerprints without changing legacy records", () => {
    expect(normalizeDocumentSidecar({ id: "abc", name: "Book.pdf", fingerprint: " fp-1 ", position: {} })?.fingerprint).toBe("fp-1");
    expect(normalizeDocumentSidecar({ id: "legacy", name: "Book.pdf", position: {} })?.fingerprint).toBeUndefined();
  });

  it("deduplicates recents newest-first by fingerprint then name and byte length", () => {
    const recent = (id: string, name: string, byteLength: number, lastOpenedAt: number, fingerprint?: string) => ({
      id,
      name,
      byteLength,
      pageCount: 1,
      importedAt: 1,
      lastOpenedAt,
      position: defaultReadingPosition(),
      ...(fingerprint ? { fingerprint } : {})
    });
    expect(dedupeRecentDocuments([
      recent("old-fingerprint", "Old name.pdf", 10, 1, "same-pdf"),
      recent("legacy-old", "Legacy.pdf", 20, 2),
      recent("new-fingerprint", "New name.pdf", 99, 5, "same-pdf"),
      recent("legacy-new", "Legacy.pdf", 20, 4),
      recent("distinct", "Legacy.pdf", 20, 3, "different-pdf")
    ]).map((item) => item.id)).toEqual(["new-fingerprint", "legacy-new", "distinct"]);
  });
});

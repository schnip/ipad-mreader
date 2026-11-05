import { describe, expect, it } from "vitest";
import { storageReport } from "./opfs";

describe("storage report", () => {
  it("reports orphaned and duplicate PDFs without changing anything", () => {
    const files = [
      { id: "aaaaaaaa", size: 100, lastModified: 1 },
      { id: "bbbbbbbb", size: 200, lastModified: 2 },
      { id: "cccccccc", size: 300, lastModified: 3 },
      { id: "dddddddd", size: 50, lastModified: 4 }
    ];
    const sidecars = [
      { id: "aaaaaaaa", fingerprint: "same", lastOpenedAt: 10 },
      { id: "bbbbbbbb", fingerprint: "same", lastOpenedAt: 5 },
      { id: "cccccccc", lastOpenedAt: 1 },
      { id: "missing1", fingerprint: "same", lastOpenedAt: 20 }
    ];
    expect(storageReport(files, sidecars)).toEqual({
      fileCount: 4,
      totalBytes: 650,
      orphanIds: ["dddddddd"],
      orphanBytes: 50,
      duplicateIds: ["bbbbbbbb"],
      duplicateBytes: 200
    });
  });

  it("handles empty storage", () => {
    expect(storageReport([], [])).toMatchObject({ fileCount: 0, totalBytes: 0, orphanIds: [], duplicateIds: [] });
  });
});

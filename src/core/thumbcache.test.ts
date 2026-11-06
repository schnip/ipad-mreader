import { describe, expect, it } from "vitest";
import { selectEvictions } from "./thumbcache";
import type { ThumbnailRecordSummary } from "./thumbcache";

const entry = (key: string, bytes: number, lastUsed: number): ThumbnailRecordSummary => ({ key, bytes: new Blob([new Uint8Array(bytes)]), lastUsed });

describe("thumbnail eviction", () => {
  it("keeps everything while the cache fits the budget", () => {
    const records = [entry("a", 100, 3), entry("b", 50, 4)];
    expect(selectEvictions(records, 400)).toEqual([]);
  });

  it("evicts oldest-used entries first until the budget is met", () => {
    const records = [entry("newest", 100, 4), entry("oldest", 100, 1), entry("middle", 100, 2)];
    expect(selectEvictions(records, 150)).toEqual(["oldest", "middle"]);
  });

  it("evicts everything when a single future entry can never fit once other space is reclaimed", () => {
    const records = [entry("huge", 900, 1), entry("small", 50, 2), entry("tiny", 10, 3)];
    expect(selectEvictions(records, 50)).toEqual(["huge", "small"]);
  });

  it("breaks lastUsed ties deterministically by key", () => {
    const records = [entry("b", 100, 1), entry("a", 100, 1), entry("c", 10, 1)];
    expect(selectEvictions(records, 20)).toEqual(["a", "b"]);
  });
});

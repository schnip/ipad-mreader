import { describe, expect, it } from "vitest";
import { addOpenDocument, closeOpenDocument, emptyOpenSession, normalizeOpenSession, selectOpenDocument } from "./session";

describe("open document sessions", () => {
  it("normalizes corruption, deduplicates, filters missing documents, and preserves order", () => {
    expect(normalizeOpenSession({
      version: 99,
      documentIds: ["b", "a", "b", 4, "missing"],
      currentId: "missing"
    }, ["a", "b"])).toEqual({ version: 1, documentIds: ["b", "a"], currentId: "b" });
    expect(normalizeOpenSession({ nope: true })).toEqual(emptyOpenSession());
  });

  it("adds once at the end and selects the imported document", () => {
    const initial = { version: 1 as const, documentIds: ["a", "b"], currentId: "a" };
    expect(addOpenDocument(initial, "c")).toEqual({ version: 1, documentIds: ["a", "b", "c"], currentId: "c" });
    expect(addOpenDocument(initial, "b")).toEqual({ version: 1, documentIds: ["a", "b"], currentId: "b" });
  });

  it("selects only documents that are explicitly open", () => {
    const initial = { version: 1 as const, documentIds: ["a", "b"], currentId: "a" };
    expect(selectOpenDocument(initial, "b").currentId).toBe("b");
    expect(selectOpenDocument(initial, "missing")).toEqual(initial);
  });

  it("chooses the next neighbor, then the previous neighbor, when closing current", () => {
    const initial = { version: 1 as const, documentIds: ["a", "b", "c"], currentId: "b" };
    expect(closeOpenDocument(initial, "b")).toEqual({ version: 1, documentIds: ["a", "c"], currentId: "c" });
    expect(closeOpenDocument({ ...initial, currentId: "c" }, "c")).toEqual({ version: 1, documentIds: ["a", "b"], currentId: "b" });
  });

  it("retains current when closing a background document and empties after the last close", () => {
    const initial = { version: 1 as const, documentIds: ["a", "b"], currentId: "b" };
    expect(closeOpenDocument(initial, "a")).toEqual({ version: 1, documentIds: ["b"], currentId: "b" });
    expect(closeOpenDocument({ version: 1, documentIds: ["b"], currentId: "b" }, "b")).toEqual(emptyOpenSession());
  });
});

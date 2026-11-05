import { describe, expect, it } from "vitest";
import { requestInTransaction } from "./idb";

interface FakeRequest {
  result?: unknown;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeTransaction {
  error: Error | null;
  oncomplete: (() => void) | null;
  onabort: (() => void) | null;
  onerror: (() => void) | null;
}

function fakes(): { request: FakeRequest; transaction: FakeTransaction } {
  return {
    request: { error: null, onsuccess: null, onerror: null },
    transaction: { error: null, oncomplete: null, onabort: null, onerror: null }
  };
}

describe("IndexedDB request/transaction pairing", () => {
  it("resolves the request value only after the transaction commits", async () => {
    const { request, transaction } = fakes();
    let settled = false;
    const pending = requestInTransaction(transaction as unknown as IDBTransaction, request as unknown as IDBRequest<string>)
      .then((value) => { settled = true; return value; });
    request.result = "value";
    request.onsuccess?.();
    await Promise.resolve();
    expect(settled).toBe(false);
    transaction.oncomplete?.();
    await expect(pending).resolves.toBe("value");
  });

  it("rejects once when the request fails and the transaction then aborts", async () => {
    const { request, transaction } = fakes();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const pending = requestInTransaction(transaction as unknown as IDBTransaction, request as unknown as IDBRequest<string>);
      request.error = new Error("constraint");
      request.onerror?.();
      transaction.error = request.error;
      transaction.onabort?.();
      await expect(pending).rejects.toThrow("constraint");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

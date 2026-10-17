/**
 * Shared raw IndexedDB plumbing for the three separate v1 databases
 * (sidecar, session, annotations). Each operation opens a short-lived
 * connection, so a version change from another window can always proceed:
 * every connection closes itself on `versionchange`, and a blocked open waits
 * for that rather than failing immediately.
 */

export interface DatabaseSpec {
  name: string;
  version: number;
  label: string;
  upgrade(database: IDBDatabase): void;
}

export function openDatabase(spec: DatabaseSpec): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(spec.name, spec.version);
    request.onerror = () => reject(request.error ?? new Error(`Unable to open the ${spec.label} database.`));
    // Another window still holds an older connection. Those connections close on
    // `versionchange`, after which this request continues to `onsuccess`.
    request.onblocked = () => console.warn(`The ${spec.label} database upgrade is waiting for another app window to close it.`);
    request.onupgradeneeded = () => spec.upgrade(request.result);
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

/**
 * Resolves only when both the request succeeded and its transaction committed.
 * Awaiting the two promises together (rather than one after the other) means a
 * failure of either is observed exactly once and never surfaces as an
 * unhandled rejection.
 */
export async function requestInTransaction<T>(transaction: IDBTransaction, request: IDBRequest<T>): Promise<T> {
  const [value] = await Promise.all([requestResult(request), transactionComplete(transaction)]);
  return value;
}

export async function withStore<T>(
  spec: DatabaseSpec,
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openDatabase(spec);
  try {
    const transaction = database.transaction(storeName, mode);
    return await requestInTransaction(transaction, operation(transaction.objectStore(storeName)));
  } finally {
    database.close();
  }
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

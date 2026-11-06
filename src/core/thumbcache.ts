import { openDatabase, requestResult, transactionComplete } from "../store/idb";

/**
 * Persistent rasterized-thumbnail cache. Rendering a thumbnail of a scanned
 * cookbook page costs about a second of JPEG 2000 decode, so finished rasters
 * are kept on disk keyed by document fingerprint, page number, and raster
 * dimensions. Cache reads are advisory: any failure degrades silently to a
 * normal pdf.js render.
 */

const DATABASE = {
  name: "mreader-thumbnails-v1",
  version: 1,
  label: "thumbnails",
  upgrade(database: IDBDatabase): void {
    const store = database.createObjectStore("thumbnails", { keyPath: "key" });
    store.createIndex("lastUsed", "lastUsed");
  }
} as const;

/** Disk budget; eviction removes the least recently used entries beyond it. */
export const THUMBNAIL_STORAGE_BUDGET_BYTES = 64 * 1024 * 1024;

export interface ThumbnailRecord {
  key: string;
  bytes: Blob;
  storedAt: number;
  lastUsed: number;
}

export type ThumbnailRecordSummary = Pick<ThumbnailRecord, "key" | "bytes" | "lastUsed">;

export interface ThumbnailStore {
  get(key: string): Promise<Blob | undefined>;
  put(key: string, canvas: HTMLCanvasElement): void;
}

export function createThumbnailStore(): ThumbnailStore | undefined {
  if (!("indexedDB" in globalThis) || typeof HTMLCanvasElement?.prototype.toBlob !== "function") return undefined;
  return {
    get: (key) => readThumbnail(key).catch(() => undefined),
    put: (key, canvas) => {
      void (async () => {
        const bytes = await encodeThumbnail(canvas);
        const now = Date.now();
        await putThumbnail({ key, bytes, storedAt: now, lastUsed: now });
        await evictBeyondBudget().catch(() => undefined);
      })().catch(() => undefined);
    }
  };
}

function encodeThumbnail(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // Scanned-photo rasters compress far better lossy, and thumbnails are only
    // ever displayed at the encoded resolution.
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Thumbnail encoding failed."))), "image/jpeg", 0.78);
  });
}

async function readThumbnail(key: string): Promise<Blob | undefined> {
  const record = await getThumbnail(key);
  if (!record) return undefined;
  // Touch the entry so LRU eviction tracks actual reuse; a hit never fails
  // because the bookkeeping failed.
  void putThumbnail({ ...record, lastUsed: Date.now() }).catch(() => undefined);
  return record.bytes;
}

/** Evicts least-recently-used entries whenever the stored bytes exceed budget. */
async function evictBeyondBudget(): Promise<void> {
  const open = await database();
  const transaction = open.transaction("thumbnails", "readwrite");
  const store = transaction.objectStore("thumbnails");
  const entries: (ThumbnailRecordSummary & { primaryKey: string })[] = [];
  const cursorRequest = store.index("lastUsed").openCursor();
  const cursorDone = new Promise<void>((resolve) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      const record = cursor.value as ThumbnailRecord;
      entries.push({ primaryKey: cursor.primaryKey as string, key: record.key, bytes: record.bytes, lastUsed: record.lastUsed });
      cursor.advance(1);
    };
    cursorRequest.onerror = () => resolve();
  });
  await cursorDone;
  for (const key of selectEvictions(entries, THUMBNAIL_STORAGE_BUDGET_BYTES)) {
    const matching = entries.find((entry) => entry.key === key);
    if (matching) store.delete(matching.primaryKey);
  }
  await transactionComplete(transaction).catch(() => undefined);
}

/**
 * Pure eviction decision for the byte budget: oldest `lastUsed` first. Keeping
 * it pure makes the budget behavior testable without an IndexedDB fake.
 */
export function selectEvictions(records: readonly ThumbnailRecordSummary[], budgetBytes: number): string[] {
  const total = records.reduce((sum, record) => sum + record.bytes.size, 0);
  const order = [...records].sort((a, b) => a.lastUsed - b.lastUsed || a.key.localeCompare(b.key));
  const evicted: string[] = [];
  let remaining = total;
  for (const record of order) {
    if (remaining <= budgetBytes) break;
    remaining -= record.bytes.size;
    evicted.push(record.key);
  }
  return evicted;
}

let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  connection ??= openDatabase(DATABASE);
  return connection;
}

function getThumbnail(key: string): Promise<ThumbnailRecord | undefined> {
  return run("readonly", (store) => store.get(key));
}

function putThumbnail(record: ThumbnailRecord): Promise<void> {
  return write("readwrite", (store) => {
    void store.put(record);
  });
}

function write(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<unknown> | void): Promise<void> {
  return database().then((open) => {
    const transaction = open.transaction("thumbnails", mode);
    operation(transaction.objectStore("thumbnails"));
    return transactionComplete(transaction);
  });
}

function run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return database().then(async (open) => {
    const transaction = open.transaction("thumbnails", mode);
    return await requestResult(operation(transaction.objectStore("thumbnails")));
  });
}

import { clamp } from "../core/scene";
import { normalizeReaderLayout } from "../core/layout";
import type { ReaderLayout } from "../core/layout";

export type FitState = "page" | "width" | "custom";

export interface ReadingPosition {
  version: 1;
  page: number;
  fit: FitState;
  scale: number;
  centerX: number;
  centerY: number;
  layout?: ReaderLayout;
}

export interface DocumentSidecar {
  id: string;
  name: string;
  byteLength: number;
  pageCount: number;
  importedAt: number;
  lastOpenedAt: number;
  position: ReadingPosition;
  fingerprint?: string;
}

const DATABASE_NAME = "mreader-sidecar";
const DATABASE_VERSION = 1;
const DOCUMENTS_STORE = "documents";

export function defaultReadingPosition(): ReadingPosition {
  return { version: 1, page: 1, fit: "page", scale: 1, centerX: 0.5, centerY: 0.5 };
}

export function normalizeReadingPosition(value: unknown, pageCount = Number.MAX_SAFE_INTEGER): ReadingPosition {
  if (!isRecord(value)) return defaultReadingPosition();
  const fit = value.fit === "width" || value.fit === "custom" ? value.fit : "page";
  const position: ReadingPosition = {
    version: 1,
    page: Math.round(clamp(finite(value.page, 1), 1, Math.max(1, pageCount))),
    fit,
    scale: clamp(finite(value.scale, 1), 1, 6),
    centerX: clamp(finite(value.centerX, 0.5), 0, 1),
    centerY: clamp(finite(value.centerY, 0.5), 0, 1)
  };
  const layout = normalizeReaderLayout(value.layout);
  if (layout !== "single") position.layout = layout;
  return position;
}

export function serializeReadingPosition(position: ReadingPosition): string {
  return JSON.stringify(normalizeReadingPosition(position));
}

export function deserializeReadingPosition(serialized: string, pageCount?: number): ReadingPosition {
  try {
    return normalizeReadingPosition(JSON.parse(serialized) as unknown, pageCount);
  } catch {
    return defaultReadingPosition();
  }
}

export function normalizeDocumentSidecar(value: unknown): DocumentSidecar | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  const pageCount = Math.max(1, Math.round(finite(value.pageCount, 1)));
  const sidecar: DocumentSidecar = {
    id: value.id,
    name: value.name,
    byteLength: Math.max(0, Math.round(finite(value.byteLength, 0))),
    pageCount,
    importedAt: Math.max(0, finite(value.importedAt, Date.now())),
    lastOpenedAt: Math.max(0, finite(value.lastOpenedAt, Date.now())),
    position: normalizeReadingPosition(value.position, pageCount)
  };
  if (typeof value.fingerprint === "string" && value.fingerprint.trim().length > 0) sidecar.fingerprint = value.fingerprint.trim();
  return sidecar;
}

export function dedupeRecentDocuments(sidecars: readonly DocumentSidecar[]): DocumentSidecar[] {
  const ordered = sidecars.map((sidecar, index) => ({ sidecar, index })).sort((a, b) => (
    b.sidecar.lastOpenedAt - a.sidecar.lastOpenedAt || a.index - b.index
  ));
  const fingerprints = new Set<string>();
  const fallbacks = new Set<string>();
  const result: DocumentSidecar[] = [];
  for (const { sidecar } of ordered) {
    const fingerprint = sidecar.fingerprint?.trim();
    const fallback = `${sidecar.name}\u0000${sidecar.byteLength}`;
    if (fingerprint ? fingerprints.has(fingerprint) : fallbacks.has(fallback)) continue;
    result.push(sidecar);
    if (fingerprint) fingerprints.add(fingerprint);
    fallbacks.add(fallback);
  }
  return result;
}

export async function putDocumentSidecar(sidecar: DocumentSidecar): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DOCUMENTS_STORE, "readwrite");
    const complete = transactionComplete(transaction);
    const request = transaction.objectStore(DOCUMENTS_STORE).put(normalizeDocumentSidecar(sidecar));
    await requestResult(request);
    await complete;
  } finally {
    database.close();
  }
}

export async function getDocumentSidecar(id: string): Promise<DocumentSidecar | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DOCUMENTS_STORE, "readonly");
    const complete = transactionComplete(transaction);
    const value = await requestResult(transaction.objectStore(DOCUMENTS_STORE).get(id));
    await complete;
    return normalizeDocumentSidecar(value);
  } finally {
    database.close();
  }
}

export async function listRecentDocuments(): Promise<DocumentSidecar[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DOCUMENTS_STORE, "readonly");
    const complete = transactionComplete(transaction);
    const values = await requestResult(transaction.objectStore(DOCUMENTS_STORE).getAll());
    await complete;
    return values
      .map((value) => normalizeDocumentSidecar(value))
      .filter((value): value is DocumentSidecar => value !== undefined)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  } finally {
    database.close();
  }
}

export async function deleteDocumentSidecar(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DOCUMENTS_STORE, "readwrite");
    const complete = transactionComplete(transaction);
    const request = transaction.objectStore(DOCUMENTS_STORE).delete(id);
    await requestResult(request);
    await complete;
  } finally {
    database.close();
  }
}

export async function updateReadingPosition(id: string, position: ReadingPosition): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DOCUMENTS_STORE, "readwrite");
      const store = transaction.objectStore(DOCUMENTS_STORE);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Reading position transaction was aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Reading position transaction failed."));
      const read = store.get(id);
      read.onerror = () => reject(read.error ?? new Error("Unable to read the document sidecar."));
      read.onsuccess = () => {
        const sidecar = normalizeDocumentSidecar(read.result);
        if (!sidecar) {
          transaction.abort();
          return;
        }
        sidecar.position = normalizeReadingPosition(position, sidecar.pageCount);
        sidecar.lastOpenedAt = Date.now();
        store.put(sidecar);
      };
    });
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Unable to open the sidecar database."));
    request.onblocked = () => reject(new Error("The sidecar database upgrade is blocked by another app window."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
        const store = database.createObjectStore(DOCUMENTS_STORE, { keyPath: "id" });
        store.createIndex("lastOpenedAt", "lastOpenedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

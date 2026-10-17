import { clamp, finite, isRecord } from "../core/math";
import { normalizeReaderLayout } from "../core/layout";
import type { ReaderLayout } from "../core/layout";
import { openDatabase, withStore } from "./idb";
import type { DatabaseSpec } from "./idb";

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

const DOCUMENTS_STORE = "documents";

const SIDECAR_DATABASE: DatabaseSpec = {
  name: "mreader-sidecar",
  version: 1,
  label: "sidecar",
  upgrade(database) {
    if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
      const store = database.createObjectStore(DOCUMENTS_STORE, { keyPath: "id" });
      store.createIndex("lastOpenedAt", "lastOpenedAt");
    }
  }
};

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
  const normalized = normalizeDocumentSidecar(sidecar);
  if (!normalized) throw new Error("The document sidecar is invalid: it needs a string id and name.");
  await withStore(SIDECAR_DATABASE, DOCUMENTS_STORE, "readwrite", (store) => store.put(normalized));
}

export async function getDocumentSidecar(id: string): Promise<DocumentSidecar | undefined> {
  const value: unknown = await withStore(SIDECAR_DATABASE, DOCUMENTS_STORE, "readonly", (store) => store.get(id));
  return normalizeDocumentSidecar(value);
}

export async function listRecentDocuments(): Promise<DocumentSidecar[]> {
  const values: unknown[] = await withStore(SIDECAR_DATABASE, DOCUMENTS_STORE, "readonly", (store) => store.getAll());
  return values
    .map((value) => normalizeDocumentSidecar(value))
    .filter((value): value is DocumentSidecar => value !== undefined)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function deleteDocumentSidecar(id: string): Promise<void> {
  await withStore(SIDECAR_DATABASE, DOCUMENTS_STORE, "readwrite", (store) => store.delete(id));
}

/**
 * Persists only the reading position. Recents order by `lastOpenedAt`, which is
 * written when a document is opened, so turning pages does not reorder them.
 */
export async function updateReadingPosition(id: string, position: ReadingPosition): Promise<void> {
  const database = await openDatabase(SIDECAR_DATABASE);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DOCUMENTS_STORE, "readwrite");
      const store = transaction.objectStore(DOCUMENTS_STORE);
      let failure: Error | undefined;
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Reading position transaction was aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Reading position transaction failed."));
      const read = store.get(id);
      read.onerror = () => reject(read.error ?? new Error("Unable to read the document sidecar."));
      read.onsuccess = () => {
        const sidecar = normalizeDocumentSidecar(read.result);
        if (!sidecar) {
          failure = new Error(`No document sidecar exists for ${id}, so its reading position was not saved.`);
          transaction.abort();
          return;
        }
        sidecar.position = normalizeReadingPosition(position, sidecar.pageCount);
        store.put(sidecar);
      };
    });
  } finally {
    database.close();
  }
}


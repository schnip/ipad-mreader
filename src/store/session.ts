export interface OpenDocumentSession {
  version: 1;
  documentIds: string[];
  currentId?: string;
}

const DATABASE_NAME = "mreader-session";
const DATABASE_VERSION = 1;
const SESSION_STORE = "state";
const SESSION_KEY = "open-documents";

export function emptyOpenSession(): OpenDocumentSession {
  return { version: 1, documentIds: [] };
}

export function normalizeOpenSession(value: unknown, availableIds?: Iterable<string>): OpenDocumentSession {
  if (!isRecord(value) || !Array.isArray(value.documentIds)) return emptyOpenSession();
  const available = availableIds === undefined ? undefined : new Set(availableIds);
  const seen = new Set<string>();
  const documentIds = value.documentIds.filter((id): id is string => {
    if (typeof id !== "string" || id.length === 0 || seen.has(id) || (available && !available.has(id))) return false;
    seen.add(id);
    return true;
  });
  const requestedCurrent = typeof value.currentId === "string" ? value.currentId : undefined;
  const currentId = requestedCurrent && seen.has(requestedCurrent) ? requestedCurrent : documentIds[0];
  return currentId ? { version: 1, documentIds, currentId } : { version: 1, documentIds };
}

export function addOpenDocument(session: OpenDocumentSession, id: string): OpenDocumentSession {
  const normalized = normalizeOpenSession(session);
  const documentIds = normalized.documentIds.includes(id) ? normalized.documentIds : [...normalized.documentIds, id];
  return { version: 1, documentIds, currentId: id };
}

export function selectOpenDocument(session: OpenDocumentSession, id: string): OpenDocumentSession {
  const normalized = normalizeOpenSession(session);
  return normalized.documentIds.includes(id) ? { ...normalized, currentId: id } : normalized;
}

export function closeOpenDocument(session: OpenDocumentSession, id: string): OpenDocumentSession {
  const normalized = normalizeOpenSession(session);
  const closingIndex = normalized.documentIds.indexOf(id);
  if (closingIndex < 0) return normalized;
  const documentIds = normalized.documentIds.filter((documentId) => documentId !== id);
  if (documentIds.length === 0) return emptyOpenSession();
  if (normalized.currentId !== id) return { version: 1, documentIds, currentId: normalized.currentId ?? documentIds[0] };
  return {
    version: 1,
    documentIds,
    currentId: documentIds[Math.min(closingIndex, documentIds.length - 1)]
  };
}

export async function loadOpenSession(): Promise<OpenDocumentSession | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SESSION_STORE, "readonly");
    const complete = transactionComplete(transaction);
    const value = await requestResult(transaction.objectStore(SESSION_STORE).get(SESSION_KEY));
    await complete;
    return value === undefined ? undefined : normalizeOpenSession(value);
  } finally {
    database.close();
  }
}

export async function saveOpenSession(session: OpenDocumentSession): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    const complete = transactionComplete(transaction);
    const request = transaction.objectStore(SESSION_STORE).put(normalizeOpenSession(session), SESSION_KEY);
    await requestResult(request);
    await complete;
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Unable to open the document session database."));
    request.onblocked = () => reject(new Error("The document session database is blocked by another app window."));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SESSION_STORE)) request.result.createObjectStore(SESSION_STORE);
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

import { isRecord } from "../core/math";
import { withStore } from "./idb";
import type { DatabaseSpec } from "./idb";

export interface OpenDocumentSession {
  version: 1;
  documentIds: string[];
  currentId?: string;
}

const SESSION_STORE = "state";
const SESSION_KEY = "open-documents";

const SESSION_DATABASE: DatabaseSpec = {
  name: "mreader-session",
  version: 1,
  label: "document session",
  upgrade(database) {
    if (!database.objectStoreNames.contains(SESSION_STORE)) database.createObjectStore(SESSION_STORE);
  }
};

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
  const value: unknown = await withStore(SESSION_DATABASE, SESSION_STORE, "readonly", (store) => store.get(SESSION_KEY));
  return value === undefined ? undefined : normalizeOpenSession(value);
}

export async function saveOpenSession(session: OpenDocumentSession): Promise<void> {
  const normalized = normalizeOpenSession(session);
  await withStore(SESSION_DATABASE, SESSION_STORE, "readwrite", (store) => store.put(normalized, SESSION_KEY));
}


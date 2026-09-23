import { normalizeAnnotation, orderAnnotations } from "../core/annotations";
import type { Annotation } from "../core/annotations";

const DATABASE_NAME = "mreader-annotations";
const DATABASE_VERSION = 1;
const ANNOTATIONS_STORE = "annotations";

export function normalizeStoredAnnotations(values: readonly unknown[], documentId?: string, pageNumber?: number): Annotation[] {
  return orderAnnotations(values
    .map(normalizeAnnotation)
    .filter((annotation): annotation is Annotation => annotation !== undefined)
    .filter((annotation) => documentId === undefined || annotation.documentId === documentId)
    .filter((annotation) => pageNumber === undefined || annotation.pageNumber === pageNumber));
}

export async function listDocumentAnnotations(documentId: string): Promise<Annotation[]> {
  if (!documentId) return [];
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ANNOTATIONS_STORE, "readonly");
    const complete = transactionComplete(transaction);
    const values = await requestResult(transaction.objectStore(ANNOTATIONS_STORE).index("documentId").getAll(IDBKeyRange.only(documentId)));
    await complete;
    return normalizeStoredAnnotations(values, documentId);
  } finally {
    database.close();
  }
}

export async function listPageAnnotations(documentId: string, pageNumber: number): Promise<Annotation[]> {
  if (!documentId || !Number.isInteger(pageNumber) || pageNumber < 1) return [];
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ANNOTATIONS_STORE, "readonly");
    const complete = transactionComplete(transaction);
    const values = await requestResult(transaction.objectStore(ANNOTATIONS_STORE).index("documentPage").getAll(IDBKeyRange.only([documentId, pageNumber])));
    await complete;
    return normalizeStoredAnnotations(values, documentId, pageNumber);
  } finally {
    database.close();
  }
}

export async function putAnnotation(value: Annotation): Promise<Annotation> {
  const annotation = normalizeAnnotation(value);
  if (!annotation) throw new Error("The annotation is invalid.");
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ANNOTATIONS_STORE, "readwrite");
    const complete = transactionComplete(transaction);
    await requestResult(transaction.objectStore(ANNOTATIONS_STORE).put(annotation));
    await complete;
    return annotation;
  } finally {
    database.close();
  }
}

export async function deleteAnnotation(documentId: string, annotationId: string): Promise<boolean> {
  if (!documentId || !annotationId) return false;
  const database = await openDatabase();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(ANNOTATIONS_STORE, "readwrite");
      const store = transaction.objectStore(ANNOTATIONS_STORE);
      let deleted = false;
      transaction.oncomplete = () => resolve(deleted);
      transaction.onabort = () => reject(transaction.error ?? new Error("Annotation delete was aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Annotation delete failed."));
      const read = store.get(annotationId);
      read.onerror = () => reject(read.error ?? new Error("Unable to read the annotation."));
      read.onsuccess = () => {
        const annotation = normalizeAnnotation(read.result);
        if (annotation?.documentId === documentId) {
          store.delete(annotationId);
          deleted = true;
        }
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
    request.onerror = () => reject(request.error ?? new Error("Unable to open the annotation database."));
    request.onblocked = () => reject(new Error("The annotation database upgrade is blocked by another app window."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ANNOTATIONS_STORE)) {
        const store = database.createObjectStore(ANNOTATIONS_STORE, { keyPath: "id" });
        store.createIndex("documentId", "documentId");
        store.createIndex("documentPage", ["documentId", "pageNumber"]);
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

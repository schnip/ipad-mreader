import { normalizeAnnotation, orderAnnotations } from "../core/annotations";
import type { Annotation } from "../core/annotations";
import { openDatabase, withStore } from "./idb";
import type { DatabaseSpec } from "./idb";

const ANNOTATIONS_STORE = "annotations";

const ANNOTATIONS_DATABASE: DatabaseSpec = {
  name: "mreader-annotations",
  version: 1,
  label: "annotation",
  upgrade(database) {
    if (!database.objectStoreNames.contains(ANNOTATIONS_STORE)) {
      const store = database.createObjectStore(ANNOTATIONS_STORE, { keyPath: "id" });
      store.createIndex("documentId", "documentId");
      store.createIndex("documentPage", ["documentId", "pageNumber"]);
    }
  }
};

export function normalizeStoredAnnotations(values: readonly unknown[], documentId?: string, pageNumber?: number): Annotation[] {
  return orderAnnotations(values
    .map(normalizeAnnotation)
    .filter((annotation): annotation is Annotation => annotation !== undefined)
    .filter((annotation) => documentId === undefined || annotation.documentId === documentId)
    .filter((annotation) => pageNumber === undefined || annotation.pageNumber === pageNumber));
}

export async function listDocumentAnnotations(documentId: string): Promise<Annotation[]> {
  if (!documentId) return [];
  const values: unknown[] = await withStore(ANNOTATIONS_DATABASE, ANNOTATIONS_STORE, "readonly", (store) => (
    store.index("documentId").getAll(IDBKeyRange.only(documentId))
  ));
  return normalizeStoredAnnotations(values, documentId);
}

export async function listPageAnnotations(documentId: string, pageNumber: number): Promise<Annotation[]> {
  if (!documentId || !Number.isInteger(pageNumber) || pageNumber < 1) return [];
  const values: unknown[] = await withStore(ANNOTATIONS_DATABASE, ANNOTATIONS_STORE, "readonly", (store) => (
    store.index("documentPage").getAll(IDBKeyRange.only([documentId, pageNumber]))
  ));
  return normalizeStoredAnnotations(values, documentId, pageNumber);
}

export async function putAnnotation(value: Annotation): Promise<Annotation> {
  const annotation = normalizeAnnotation(value);
  if (!annotation) throw new Error("The annotation is invalid.");
  await withStore(ANNOTATIONS_DATABASE, ANNOTATIONS_STORE, "readwrite", (store) => store.put(annotation));
  return annotation;
}

export async function deleteAnnotation(documentId: string, annotationId: string): Promise<boolean> {
  if (!documentId || !annotationId) return false;
  const database = await openDatabase(ANNOTATIONS_DATABASE);
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

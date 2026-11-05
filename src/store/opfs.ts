export interface StoredPdfFile {
  id: string;
  size: number;
  lastModified: number;
}

const DIRECTORY_NAME = "mreader-documents-v1";
const PDF_SUFFIX = ".pdf";

interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

export function createDocumentId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function importPdf(file: File, id = createDocumentId()): Promise<StoredPdfFile> {
  assertId(id);
  if (file.size === 0) throw new Error("The selected PDF is empty.");
  const directory = await documentsDirectory();
  const handle = await directory.getFileHandle(fileName(id), { create: true });
  if (typeof handle.createWritable !== "function") {
    await directory.removeEntry(fileName(id)).catch(() => undefined);
    throw new Error("This browser version cannot write files to device storage. Update iPadOS/Safari to import PDFs.");
  }
  try {
    const writable = await handle.createWritable();
    await file.stream().pipeTo(writable);
    const stored = await handle.getFile();
    if (stored.size !== file.size) throw new Error("The complete PDF was not written to device storage.");
    return { id, size: stored.size, lastModified: stored.lastModified };
  } catch (error) {
    await directory.removeEntry(fileName(id)).catch(() => undefined);
    throw new Error(`Unable to store ${file.name}: ${errorMessage(error)}`, { cause: error });
  }
}

export async function readPdf(id: string): Promise<Uint8Array> {
  assertId(id);
  const directory = await documentsDirectory();
  try {
    const handle = await directory.getFileHandle(fileName(id));
    // pdf.js takes ownership of a whole-buffer Uint8Array and transfers it to
    // its worker, so the main thread does not keep a second copy.
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (error) {
    throw new Error(`Stored PDF ${id} is unavailable: ${errorMessage(error)}`, { cause: error });
  }
}

export interface StorageReport {
  fileCount: number;
  totalBytes: number;
  /** Stored PDFs that no sidecar references, e.g. left by an interrupted import. */
  orphanIds: string[];
  orphanBytes: number;
  /** Extra copies of the same PDF (by fingerprint) imported more than once. */
  duplicateIds: string[];
  duplicateBytes: number;
}

/**
 * Read-only storage diagnostic. It never deletes anything: originals and
 * sidecars are only reported so the space they use is visible.
 */
export function storageReport(
  files: readonly StoredPdfFile[],
  sidecars: readonly { id: string; fingerprint?: string; lastOpenedAt: number }[]
): StorageReport {
  const sizes = new Map(files.map((file) => [file.id, file.size]));
  const referenced = new Set(sidecars.map((sidecar) => sidecar.id));
  const orphanIds = files.filter((file) => !referenced.has(file.id)).map((file) => file.id).sort();
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const sidecar of [...sidecars].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)) {
    const fingerprint = sidecar.fingerprint?.trim();
    if (!fingerprint || !sizes.has(sidecar.id)) continue;
    if (seen.has(fingerprint)) duplicateIds.push(sidecar.id);
    else seen.add(fingerprint);
  }
  const bytes = (ids: readonly string[]) => ids.reduce((total, id) => total + (sizes.get(id) ?? 0), 0);
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    orphanIds,
    orphanBytes: bytes(orphanIds),
    duplicateIds: duplicateIds.sort(),
    duplicateBytes: bytes(duplicateIds)
  };
}

export async function listPdfs(): Promise<StoredPdfFile[]> {
  const directory = await documentsDirectory();
  const result: StoredPdfFile[] = [];
  for await (const [name, handle] of (directory as IterableDirectoryHandle).entries()) {
    if (handle.kind !== "file" || !name.endsWith(PDF_SUFFIX)) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    result.push({ id: name.slice(0, -PDF_SUFFIX.length), size: file.size, lastModified: file.lastModified });
  }
  return result.sort((a, b) => b.lastModified - a.lastModified);
}

export async function deletePdf(id: string): Promise<void> {
  assertId(id);
  const directory = await documentsDirectory();
  await directory.removeEntry(fileName(id)).catch((error: unknown) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  });
}

async function documentsDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) {
    throw new Error("Device document storage requires HTTPS and an OPFS-capable browser.");
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIRECTORY_NAME, { create: true });
}

function fileName(id: string): string {
  return `${id}${PDF_SUFFIX}`;
}

function assertId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error("Invalid stored document identifier.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

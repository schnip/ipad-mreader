export interface OpfsResult {
  fileName: string;
  bytes: number;
  writeMs: number;
  readMs: number;
  verified: boolean;
  persisted: boolean;
  quota?: number;
  usageBefore?: number;
  usageAfter?: number;
}

async function spikeDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) {
    throw new Error("OPFS is unavailable. Use HTTPS or an installed PWA on a supported browser.");
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("mreader-p0-spike", { create: true });
}

export async function runOpfsRoundTrip(file: File): Promise<OpfsResult> {
  const before = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
  const directory = await spikeDirectory();
  const handle = await directory.getFileHandle(file.name, { create: true });

  const writeStart = performance.now();
  const writable = await handle.createWritable();
  await file.stream().pipeTo(writable);
  const writeMs = performance.now() - writeStart;

  const stored = await handle.getFile();
  const readStart = performance.now();
  const bytesRead = await consume(stored.stream());
  const readMs = performance.now() - readStart;
  const verified = await verifyEdges(file, stored);
  const after = await navigator.storage.estimate();

  return {
    fileName: file.name,
    bytes: stored.size,
    writeMs,
    readMs,
    verified: verified && bytesRead === stored.size,
    persisted,
    quota: after.quota,
    usageBefore: before.usage,
    usageAfter: after.usage
  };
}

async function consume(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

async function verifyEdges(original: Blob, stored: Blob): Promise<boolean> {
  if (original.size !== stored.size) return false;
  const sampleSize = Math.min(64 * 1024, original.size);
  const ranges: Array<[number, number]> = [
    [0, sampleSize],
    [Math.max(0, original.size - sampleSize), original.size]
  ];
  for (const [start, end] of ranges) {
    const [left, right] = await Promise.all([
      original.slice(start, end).arrayBuffer(),
      stored.slice(start, end).arrayBuffer()
    ]);
    const leftBytes = new Uint8Array(left);
    const rightBytes = new Uint8Array(right);
    if (leftBytes.some((value, index) => value !== rightBytes[index])) return false;
  }
  return true;
}

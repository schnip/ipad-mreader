interface ProcessMessage {
  type: "process";
  id: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

interface DestroyMessage {
  type: "destroy";
}

type IncomingMessage = ProcessMessage | DestroyMessage;

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<IncomingMessage>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  close(): void;
};

workerScope.onmessage = (event) => {
  if (event.data.type === "destroy") {
    workerScope.close();
    return;
  }
  const { id, bitmap, width, height } = event.data;
  try {
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Offscreen 2D canvas is unavailable.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const result = canvas.transferToImageBitmap();
    workerScope.postMessage({ type: "result", id, bitmap: result }, [result]);
  } catch (error) {
    bitmap.close();
    workerScope.postMessage({ type: "error", id, message: error instanceof Error ? error.message : String(error) }, []);
  }
};

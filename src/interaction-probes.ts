import { characterIndexAt, decideSwipe, distance, midpoint, pointInLocalSpace, zoomAroundPoint } from "./gesture-math";
import type { Camera, Point } from "./gesture-math";

interface TouchSnapshot {
  startedAt: number;
  start: Point;
  latest: Point;
}

interface PinchSnapshot {
  distance: number;
  center: Point;
  camera: Camera;
}

export class GestureProbe {
  private enabled = true;
  private selectionMode = false;
  private camera: Camera = { x: 0, y: 0, scale: 1 };
  private touch?: TouchSnapshot;
  private pinch?: PinchSnapshot;
  private swipeOffset = 0;
  private animating = false;
  private readonly penPointers = new Set<number>();
  private suppressTouchesUntil = 0;

  constructor(
    private readonly scene: HTMLElement,
    private readonly stage: HTMLElement,
    private readonly turnPage: (direction: -1 | 1) => Promise<boolean>,
    private readonly report: (message: string, data?: unknown) => void
  ) {
    this.install();
  }

  reset(): void {
    this.camera = { x: 0, y: 0, scale: 1 };
    this.swipeOffset = 0;
    this.applyTransform();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  setSelectionMode(enabled: boolean): void {
    this.selectionMode = enabled;
    this.cancel();
  }

  private install(): void {
    this.scene.addEventListener("pointerdown", (event) => this.onPointerDown(event), { capture: true });
    this.scene.addEventListener("pointerup", (event) => this.onPointerEnd(event), { capture: true });
    this.scene.addEventListener("pointercancel", (event) => this.onPointerEnd(event), { capture: true });
    this.scene.addEventListener("touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.scene.addEventListener("touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.scene.addEventListener("touchend", (event) => void this.onTouchEnd(event), { passive: false });
    this.scene.addEventListener("touchcancel", () => this.cancel(), { passive: false });
    for (const eventName of ["gesturestart", "gesturechange", "gestureend"]) {
      this.scene.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    this.penPointers.add(event.pointerId);
    this.suppressTouchesUntil = Number.POSITIVE_INFINITY;
    this.cancel();
  }

  private onPointerEnd(event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    this.penPointers.delete(event.pointerId);
    if (this.penPointers.size === 0) this.suppressTouchesUntil = performance.now() + 250;
    this.cancel();
  }

  private isPenInputActive(): boolean {
    return this.penPointers.size > 0 || performance.now() < this.suppressTouchesUntil;
  }

  private onTouchStart(event: TouchEvent): void {
    if (!this.enabled) return;
    if (this.isPenInputActive()) {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (this.animating) return;
    const edgeTouch = [...event.changedTouches].some((touch) => touch.clientX < 28 || touch.clientX > window.innerWidth - 28);
    if (edgeTouch) {
      event.preventDefault();
      this.report("Edge touch default prevented", { x: event.changedTouches[0]?.clientX });
    }
    if (event.touches.length === 2) {
      event.preventDefault();
      const [first, second] = this.points(event.touches);
      if (!first || !second) return;
      this.pinch = { distance: distance(first, second), center: midpoint(first, second), camera: { ...this.camera } };
      this.touch = undefined;
    } else if (event.touches.length === 1 && !this.selectionMode) {
      const point = this.point(event.touches[0]);
      if (!point) return;
      this.touch = { startedAt: performance.now(), start: point, latest: point };
    }
  }

  private onTouchMove(event: TouchEvent): void {
    if (!this.enabled) return;
    event.preventDefault();
    if (this.isPenInputActive()) {
      this.cancel();
      return;
    }
    if (event.touches.length === 2 && this.pinch) {
      const [first, second] = this.points(event.touches);
      if (!first || !second) return;
      const center = midpoint(first, second);
      this.camera = zoomAroundPoint(this.pinch.camera, distance(first, second) / Math.max(this.pinch.distance, 1), this.pinch.center, center);
      this.swipeOffset = 0;
      this.applyTransform();
      return;
    }
    if (event.touches.length !== 1 || !this.touch) return;
    const current = this.point(event.touches[0]);
    if (!current) return;
    const previous = this.touch.latest;
    const deltaX = current.x - this.touch.start.x;
    const deltaY = current.y - this.touch.start.y;
    this.touch.latest = current;
    if (this.camera.scale <= 1.01 && Math.abs(deltaX) > Math.abs(deltaY) * 1.15) {
      this.swipeOffset = deltaX;
    } else if (this.camera.scale > 1.01) {
      this.camera.x += current.x - previous.x;
      this.camera.y += current.y - previous.y;
    }
    this.applyTransform();
  }

  private async onTouchEnd(event: TouchEvent): Promise<void> {
    if (!this.enabled) return;
    event.preventDefault();
    if (this.isPenInputActive()) {
      this.cancel();
      return;
    }
    if (event.touches.length > 0) return;
    if (this.pinch) {
      this.report("Pinch settled", this.camera);
      this.pinch = undefined;
      if (this.camera.scale <= 1.01) this.reset();
      return;
    }
    if (!this.touch) return;
    const direction = decideSwipe({
      deltaX: this.touch.latest.x - this.touch.start.x,
      deltaY: this.touch.latest.y - this.touch.start.y,
      elapsedMs: performance.now() - this.touch.startedAt,
      viewportWidth: this.scene.clientWidth
    });
    this.touch = undefined;
    if (direction === 0 || this.camera.scale > 1.01) {
      this.swipeOffset = 0;
      this.stage.classList.add("settling");
      this.applyTransform();
      window.setTimeout(() => this.stage.classList.remove("settling"), 220);
      return;
    }
    await this.animatePageTurn(direction);
  }

  private async animatePageTurn(direction: -1 | 1): Promise<void> {
    this.animating = true;
    this.stage.classList.add("settling");
    this.swipeOffset = direction > 0 ? -this.scene.clientWidth : this.scene.clientWidth;
    this.applyTransform();
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const changed = await this.turnPage(direction);
    this.stage.classList.remove("settling");
    this.swipeOffset = 0;
    this.applyTransform();
    this.animating = false;
    this.report(changed ? "Page swipe completed" : "Page boundary reached", { direction });
  }

  private cancel(): void {
    this.touch = undefined;
    this.pinch = undefined;
    this.swipeOffset = 0;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.stage.style.transform = `translate3d(${this.camera.x + this.swipeOffset}px, ${this.camera.y}px, 0) scale(${this.camera.scale})`;
  }

  private point(touch?: Touch): Point | undefined {
    return touch ? { x: touch.clientX, y: touch.clientY } : undefined;
  }

  private points(touches: TouchList): [Point | undefined, Point | undefined] {
    return [this.point(touches[0]), this.point(touches[1])];
  }
}

export class PencilProbe {
  private activePointer?: number;
  private last?: Point;
  private maxCoalesced = 0;

  constructor(
    private readonly scene: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly report: (message: string, data?: unknown) => void
  ) {
    scene.addEventListener("pointerdown", (event) => this.onDown(event));
    scene.addEventListener("pointermove", (event) => this.onMove(event));
    scene.addEventListener("pointerup", (event) => this.onUp(event));
    scene.addEventListener("pointercancel", (event) => this.onUp(event));
  }

  clear(): void {
    this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private onDown(event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    event.preventDefault();
    this.activePointer = event.pointerId;
    this.scene.setPointerCapture(event.pointerId);
    this.last = this.toCanvasPoint(event);
    this.report("Pencil detected", this.telemetry(event, 1));
  }

  private onMove(event: PointerEvent): void {
    if (event.pointerId !== this.activePointer || !this.last) return;
    event.preventDefault();
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
    this.maxCoalesced = Math.max(this.maxCoalesced, coalesced.length);
    const context = this.canvas.getContext("2d");
    if (!context) return;
    const dpr = this.canvas.width / Math.max(this.canvas.clientWidth, 1);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#e65050";
    for (const sample of coalesced) {
      const current = this.toCanvasPoint(sample);
      context.beginPath();
      context.moveTo(this.last.x * dpr, this.last.y * dpr);
      context.lineTo(current.x * dpr, current.y * dpr);
      context.lineWidth = (1.5 + sample.pressure * 7) * dpr;
      context.stroke();
      this.last = current;
    }
  }

  private onUp(event: PointerEvent): void {
    if (event.pointerId !== this.activePointer) return;
    this.report("Pencil stroke completed", this.telemetry(event, this.maxCoalesced));
    this.activePointer = undefined;
    this.last = undefined;
    this.maxCoalesced = 0;
  }

  private telemetry(event: PointerEvent, samples: number): Record<string, unknown> {
    return {
      pointerType: event.pointerType,
      pressure: event.pressure,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      coalescedSupported: typeof event.getCoalescedEvents === "function",
      maxCoalescedSamples: samples
    };
  }

  private toCanvasPoint(event: PointerEvent): Point {
    const bounds = this.canvas.getBoundingClientRect();
    return pointInLocalSpace(
      { x: event.clientX, y: event.clientY },
      bounds,
      this.canvas.clientWidth,
      this.canvas.clientHeight
    );
  }
}

export class SelectionProbe {
  private enabled = false;
  private anchor?: SelectionPoint;
  private focus?: SelectionPoint;
  private activePointer?: number;
  private readonly touchPointers = new Set<number>();

  constructor(private readonly layer: HTMLElement) {
    layer.addEventListener("pointerdown", (event) => this.start(event));
    layer.addEventListener("pointermove", (event) => this.move(event));
    layer.addEventListener("pointerup", (event) => this.finish(event));
    layer.addEventListener("pointercancel", (event) => this.finish(event));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.layer.classList.toggle("selection-enabled", enabled);
    if (!enabled) this.clear();
  }

  private start(event: PointerEvent): void {
    if (!this.enabled || event.pointerType === "pen") return;
    if (event.pointerType === "touch") this.touchPointers.add(event.pointerId);
    if (this.touchPointers.size > 1) {
      this.cancelDrag();
      return;
    }
    const point = this.selectionPoint(event.clientX, event.target);
    if (!point) return;
    event.preventDefault();
    this.layer.setPointerCapture(event.pointerId);
    this.activePointer = event.pointerId;
    this.anchor = point;
    this.focus = point;
    this.paint();
  }

  private move(event: PointerEvent): void {
    if (!this.enabled || event.pointerId !== this.activePointer || !this.anchor) return;
    event.preventDefault();
    const target = document.elementsFromPoint(event.clientX, event.clientY).find((element) => element.classList.contains("text-item"));
    const point = this.selectionPoint(event.clientX, target);
    if (point && (point.item !== this.focus?.item || point.character !== this.focus.character)) {
      this.focus = point;
      this.paint();
    }
  }

  private finish(event: PointerEvent): void {
    this.touchPointers.delete(event.pointerId);
    if (event.pointerId !== this.activePointer) return;
    this.activePointer = undefined;
    this.anchor = undefined;
  }

  private paint(): void {
    if (!this.anchor || !this.focus) return;
    const [low, high] = this.compare(this.anchor, this.focus) <= 0
      ? [this.anchor, this.focus]
      : [this.focus, this.anchor];
    const items = [...this.layer.querySelectorAll<HTMLElement>(".text-item")];
    for (const [index, item] of items.entries()) {
      const length = this.itemLength(item);
      const selected = index >= low.item && index <= high.item;
      item.classList.toggle("selected", selected);
      if (!selected) {
        item.style.removeProperty("--selection-start");
        item.style.removeProperty("--selection-end");
        continue;
      }
      const start = index === low.item ? low.character : 0;
      const end = index === high.item ? high.character + 1 : length;
      item.style.setProperty("--selection-start", `${(start / Math.max(length, 1)) * 100}%`);
      item.style.setProperty("--selection-end", `${(end / Math.max(length, 1)) * 100}%`);
    }
    this.layer.querySelectorAll(".selection-handle").forEach((handle) => handle.remove());
    this.addHandle(items[low.item], "start", low.character);
    this.addHandle(items[high.item], "end", high.character + 1);
  }

  private addHandle(item: HTMLElement | undefined, position: "start" | "end", offset: number): void {
    if (!item) return;
    const handle = document.createElement("i");
    handle.className = `selection-handle ${position}`;
    handle.style.left = `${(offset / Math.max(this.itemLength(item), 1)) * 100}%`;
    item.append(handle);
  }

  private clear(): void {
    this.layer.querySelectorAll(".selected").forEach((item) => item.classList.remove("selected"));
    this.layer.querySelectorAll(".selection-handle").forEach((handle) => handle.remove());
    this.anchor = undefined;
    this.focus = undefined;
    this.activePointer = undefined;
    this.touchPointers.clear();
  }

  private selectionPoint(clientX: number, target: EventTarget | undefined | null): SelectionPoint | undefined {
    if (!(target instanceof Element)) return undefined;
    const item = target.closest<HTMLElement>(".text-item");
    if (!item?.dataset.index) return undefined;
    const character = characterIndexAt(clientX, item.getBoundingClientRect().left, item.getBoundingClientRect().width, this.itemLength(item));
    return character === undefined ? undefined : { item: Number(item.dataset.index), character };
  }

  private itemLength(item: HTMLElement): number {
    return Number(item.dataset.length ?? 0);
  }

  private compare(a: SelectionPoint, b: SelectionPoint): number {
    return a.item === b.item ? a.character - b.character : a.item - b.item;
  }

  private cancelDrag(): void {
    if (this.activePointer !== undefined && this.layer.hasPointerCapture(this.activePointer)) {
      this.layer.releasePointerCapture(this.activePointer);
    }
    this.activePointer = undefined;
    this.anchor = undefined;
  }
}

interface SelectionPoint {
  item: number;
  character: number;
}

export function installHistoryDefense(report: (message: string, data?: unknown) => void): void {
  history.replaceState({ mreader: "root" }, "");
  history.pushState({ mreader: "guard" }, "");
  window.addEventListener("popstate", () => {
    report("Back navigation absorbed", { at: performance.now() });
    history.pushState({ mreader: "guard" }, "");
  });
}

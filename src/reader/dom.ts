/** Small DOM helpers shared by the reader and its controllers. */
import type { OutlineTreeItem } from "../core/outline";
import { releaseCanvas } from "../core/render";
import type { Point } from "../core/scene";

export function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Required reader element is missing: ${selector}`);
  return element;
}

/** Unmounts a canvas and shrinks its backing store so WebKit frees it promptly. */
export function discardCanvas(canvas: HTMLCanvasElement): void {
  releaseCanvas(canvas);
  canvas.remove();
}

export function documentElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

export function renderOutlineList(items: readonly OutlineTreeItem[], indexes: ReadonlyMap<string, number>, root: boolean): HTMLUListElement {
  const list = documentElement("ul", root ? "outline-list" : "outline-group");
  list.setAttribute("role", root ? "tree" : "group");
  for (const item of items) {
    const row = documentElement("li", `outline-item${item.children.length > 0 ? " has-children" : ""}`);
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(item.level));
    if (item.children.length > 0) row.setAttribute("aria-expanded", "true");
    const line = documentElement("div", "outline-line");
    if (item.children.length > 0) {
      const disclosure = documentElement("button", "outline-disclosure");
      disclosure.type = "button";
      disclosure.dataset.outlineToggle = item.path.join("/");
      disclosure.dataset.outlineTitle = item.title;
      disclosure.setAttribute("aria-expanded", "true");
      disclosure.setAttribute("aria-label", `Collapse ${item.title}`);
      disclosure.textContent = "▾";
      line.append(disclosure);
    } else {
      line.append(documentElement("span", "outline-disclosure-spacer"));
    }
    const button = documentElement("button", "outline-button");
    button.type = "button";
    const index = indexes.get(item.path.join("/"));
    if (index !== undefined) button.dataset.outlineIndex = String(index);
    button.textContent = item.title;
    line.append(button);
    row.append(line);
    if (item.children.length > 0) row.append(renderOutlineList(item.children, indexes, false));
    list.append(row);
  }
  return list;
}

/**
 * Copies text using the async clipboard when available, falling back to a
 * transient off-screen textarea for Safari configurations that reject
 * `navigator.clipboard` writes. Returns whether the copy succeeded.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy selection-based copy path.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;-webkit-user-select:text;user-select:text";
  document.body.append(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function touchPoint(touch: Touch | undefined): Point | undefined {
  return touch ? { x: touch.clientX, y: touch.clientY } : undefined;
}

export function touchPoints(touches: TouchList): [Point, Point] | undefined {
  const first = touchPoint(touches[0]);
  const second = touchPoint(touches[1]);
  return first && second ? [first, second] : undefined;
}

/** Whether an event target belongs to a control that owns its own input. */
export function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button,input,[data-reader-control]") !== null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

export function pixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Keeps Tab and Shift+Tab inside a modal container. */
export function trapFocus(event: KeyboardEvent, container: HTMLElement): void {
  const focusable = [...container.querySelectorAll<HTMLElement>("button:not([disabled]),textarea,input,[tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.closest("[hidden]"));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

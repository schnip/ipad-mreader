/**
 * Owns which reader panel is open. Exactly one of Find, More, the drawer, or
 * the note editor can be open at a time; opening one closes the other, and
 * closing returns keyboard focus to wherever it was before the panel opened.
 */
export type PanelKind = "find" | "more" | "drawer" | "note";

export type PanelElements = Readonly<Record<PanelKind, HTMLElement>> & { readonly backdrop: HTMLElement };

export class PanelController {
  private current?: PanelKind;
  private returnFocus?: HTMLElement;

  constructor(
    private readonly elements: PanelElements,
    /** Called after a panel closes, so its owner can release panel-specific state. */
    private readonly onClosed: (kind: PanelKind) => void = () => undefined
  ) {}

  get active(): PanelKind | undefined {
    return this.current;
  }

  isOpen(kind?: PanelKind): boolean {
    return kind === undefined ? this.current !== undefined : this.current === kind;
  }

  open(kind: PanelKind, focusTarget?: HTMLElement | null): void {
    if (this.current && this.current !== kind) this.close();
    const panel = this.elements[kind];
    const active = document.activeElement;
    if (!this.returnFocus && active instanceof HTMLElement && active !== document.body && !panel.contains(active)) {
      this.returnFocus = active;
    }
    this.current = kind;
    panel.hidden = false;
    this.elements.backdrop.hidden = false;
    focusTarget?.focus();
  }

  /** Closes the open panel, if any. Returns which panel was closed. */
  close(): PanelKind | undefined {
    const closed = this.current;
    this.current = undefined;
    for (const kind of ["find", "more", "drawer", "note"] as const) this.elements[kind].hidden = true;
    this.elements.backdrop.hidden = true;
    if (!closed) return undefined;
    this.onClosed(closed);
    const target = this.returnFocus;
    this.returnFocus = undefined;
    if (target?.isConnected && !target.closest("[hidden],[inert]")) target.focus({ preventScroll: true });
    return closed;
  }
}

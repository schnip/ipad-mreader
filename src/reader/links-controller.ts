import type { PdfDocument } from "../core/doc";
import type { PageLayout } from "../core/layout";
import { externalLinkLabel, pageActionLabel, pageForPdfAction } from "../core/links";
import type { PdfLink } from "../core/links";
import { documentElement } from "./dom";

export interface LinkTarget {
  pageNumber: number;
  layout: PageLayout;
}

export interface LinkContext {
  currentDocument(): PdfDocument | undefined;
  /** Whether links are live: reading view only, never the thumbnail grid. */
  linksActive(): boolean;
  /** The layer links are drawn into for the current layout. */
  activeLayer(): HTMLElement;
  visibleTargets(): LinkTarget[];
  /** Stops any pending tap or touch so a link tap cannot also turn a page. */
  claimInput(): void;
  goToPage(pageNumber: number): Promise<void>;
  openExternalUrl(url: string): void;
  confirm(message: string): boolean;
  reportUnavailable(): void;
}

interface VisiblePdfLink {
  link: PdfLink;
  sourcePage: number;
}

/**
 * Accessible, camera-aligned buttons for PDF link annotations on visible
 * pages. Internal destinations and page actions navigate in-app; external URLs
 * (already restricted to safe protocols) open only after confirmation.
 */
export class LinksController {
  private generation = 0;
  private readonly visible = new Map<string, VisiblePdfLink>();

  constructor(private readonly layers: readonly HTMLElement[], private readonly context: LinkContext) {}

  async refresh(): Promise<void> {
    const document = this.context.currentDocument();
    const generation = this.clear();
    if (!document || !this.context.linksActive()) return;
    const layer = this.context.activeLayer();
    const pages = await Promise.all(this.context.visibleTargets().map(async (target) => {
      try {
        return { target, links: await document.pageLinks(target.pageNumber) };
      } catch (error) {
        console.warn(`Links on page ${target.pageNumber} are unavailable`, error);
        return { target, links: [] };
      }
    }));
    if (generation !== this.generation || document !== this.context.currentDocument() || !this.context.linksActive()) return;
    for (const { target, links } of pages) {
      links.forEach((link, index) => this.render(link, target.pageNumber, index, target.layout, layer, generation));
    }
  }

  /** Removes every link button and invalidates in-flight refreshes. Returns the new generation. */
  clear(): number {
    this.generation += 1;
    this.visible.clear();
    for (const layer of this.layers) layer.replaceChildren();
    return this.generation;
  }

  /** Click handler for the link layers. */
  onActivate(event: Event): void {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-pdf-link]") : null;
    const visible = button?.dataset.pdfLink ? this.visible.get(button.dataset.pdfLink) : undefined;
    if (!visible) return;
    event.preventDefault();
    event.stopPropagation();
    this.context.claimInput();
    const { link } = visible;
    if (link.target.kind === "url") {
      if (this.context.confirm(`Open this external link?\n\n${link.target.url}`)) this.context.openExternalUrl(link.target.url);
      return;
    }
    void this.followInternal(visible);
  }

  private render(link: PdfLink, sourcePage: number, index: number, layout: PageLayout, layer: HTMLElement, generation: number): void {
    const key = `${generation}:${sourcePage}:${index}`;
    this.visible.set(key, { link, sourcePage });
    const button = documentElement("button", "pdf-link");
    button.type = "button";
    button.dataset.pdfLink = key;
    button.style.left = `${layout.x + link.rect.x * layout.width}px`;
    button.style.top = `${layout.y + link.rect.y * layout.height}px`;
    button.style.width = `${Math.max(1, link.rect.width * layout.width)}px`;
    button.style.height = `${Math.max(1, link.rect.height * layout.height)}px`;
    if (link.target.kind === "url") {
      button.setAttribute("aria-label", `Open external PDF link: ${externalLinkLabel(link.target.url)}`);
      button.title = link.target.url;
    } else if (link.target.kind === "action") {
      button.setAttribute("aria-label", pageActionLabel(link.target.action));
    } else {
      button.setAttribute("aria-label", "Follow internal PDF link");
    }
    layer.append(button);
  }

  private async followInternal({ link, sourcePage }: VisiblePdfLink): Promise<void> {
    const document = this.context.currentDocument();
    if (!document) return;
    const targetPage = link.target.kind === "destination"
      ? await document.resolveDestination(link.target.destination)
      : link.target.kind === "action" ? pageForPdfAction(link.target.action, sourcePage, document.pageCount) : undefined;
    if (document !== this.context.currentDocument()) return;
    if (!targetPage) {
      this.context.reportUnavailable();
      return;
    }
    await this.context.goToPage(targetPage);
  }
}

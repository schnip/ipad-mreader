import type { PdfDocument } from "../core/doc";
import type { PageLayout } from "../core/layout";
import { errorMessage } from "../core/math";
import { SearchGeneration, normalizeSearchText, searchPages } from "../core/search";
import type { SearchHit } from "../core/search";
import { SEARCH_INPUT_DEBOUNCE_MS } from "../core/tuning";
import { documentElement } from "./dom";

export interface SearchTarget {
  pageNumber: number;
  layout: PageLayout;
  layer: HTMLElement;
}

export interface SearchContext {
  currentDocument(): PdfDocument | undefined;
  /** Pages currently laid out on screen, with the layer their hit marks go in. */
  visibleTargets(): SearchTarget[];
  goToPage(pageNumber: number): Promise<void>;
}

export interface SearchElements {
  input: HTMLInputElement;
  results: HTMLElement;
  summary: HTMLElement;
  /** Every layer hit marks may be drawn into. */
  hitLayers: readonly HTMLElement[];
}

/**
 * Find: debounced, cancellable scanning, the result list, previous/next, and
 * the non-interactive hit marks drawn over visible pages.
 */
export class SearchController {
  private readonly generations = new SearchGeneration();
  private inputTimer?: number;
  private hits: SearchHit[] = [];
  private active = -1;
  private overlayGeneration = 0;

  constructor(private readonly elements: SearchElements, private readonly context: SearchContext) {}

  get hitCount(): number {
    return this.hits.length;
  }

  /** Schedules a scan after typing pauses; any running scan is cancelled now. */
  onInput(): void {
    this.generations.cancel();
    this.clearInputTimer();
    this.inputTimer = window.setTimeout(() => {
      this.inputTimer = undefined;
      void this.run();
    }, SEARCH_INPUT_DEBOUNCE_MS);
  }

  /** Stops scanning without discarding results (Find closed). */
  stop(): void {
    this.generations.cancel();
    this.clearInputTimer();
  }

  /** Discards the query state and all results (document switch). */
  clear(): void {
    this.stop();
    this.overlayGeneration += 1;
    this.hits = [];
    this.active = -1;
    this.clearHitLayers();
    this.elements.results.replaceChildren();
    this.elements.summary.textContent = "Enter text to search.";
  }

  async run(): Promise<void> {
    const document = this.context.currentDocument();
    const query = this.elements.input.value.trim();
    this.clearInputTimer();
    this.generations.cancel();
    this.hits = [];
    this.active = -1;
    this.clearHitLayers();
    if (!document || !query) {
      this.elements.summary.textContent = "Enter text to search.";
      this.elements.results.replaceChildren();
      return;
    }
    this.elements.summary.textContent = `Scanning 0 of ${document.pageCount}…`;
    this.elements.results.replaceChildren();
    try {
      const result = await searchPages(
        document.pageCount,
        query,
        (pageNumber, signal) => document.pageText(pageNumber, signal),
        this.generations,
        (progress) => {
          if (document !== this.context.currentDocument()) return;
          this.elements.summary.textContent = `Scanning ${progress.scanned} of ${progress.total} · ${progress.matchCount} matches`;
        }
      );
      if (result.cancelled || document !== this.context.currentDocument()) return;
      this.hits = result.hits;
      this.active = result.hits.length > 0 ? 0 : -1;
      this.renderResults();
      const failed = result.failedPages > 0 ? ` · ${result.failedPages} unreadable` : "";
      this.elements.summary.textContent = result.textPages === 0
        ? `Scanned ${result.total} pages · no searchable text${failed}`
        : `${result.matchCount} matches · ${result.total} pages scanned${failed}`;
      if (this.active >= 0) await this.goTo(this.active);
    } catch (error) {
      this.elements.summary.textContent = `Search failed: ${errorMessage(error)}`;
    }
  }

  async move(direction: -1 | 1): Promise<void> {
    if (this.hits.length === 0) return;
    const current = this.active < 0 ? 0 : this.active;
    this.active = (current + direction + this.hits.length) % this.hits.length;
    this.renderResults();
    await this.goTo(this.active);
  }

  async selectResult(event: Event): Promise<void> {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-search-index]") : null;
    const index = Number(button?.dataset.searchIndex);
    if (!Number.isInteger(index) || index < 0 || index >= this.hits.length) return;
    this.active = index;
    this.renderResults();
    await this.goTo(index);
  }

  /** Redraws hit marks for the pages currently on screen. */
  async refreshHits(): Promise<void> {
    const document = this.context.currentDocument();
    const generation = ++this.overlayGeneration;
    this.clearHitLayers();
    if (!document || this.hits.length === 0) return;
    const targets = this.context.visibleTargets().filter((target) => this.hits.some((hit) => hit.pageNumber === target.pageNumber));
    const texts = await Promise.all(targets.map(async (target) => ({ target, text: await document.pageText(target.pageNumber) })));
    if (generation !== this.overlayGeneration || document !== this.context.currentDocument()) return;
    for (const { target, text } of texts) {
      const pageHits = this.hits.map((hit, index) => ({ hit, index })).filter(({ hit }) => hit.pageNumber === target.pageNumber);
      for (const { hit, index } of pageHits) {
        for (const segment of hit.segments) {
          const item = text.items[segment.itemIndex];
          if (!item) continue;
          const normalizedLength = Math.max(1, normalizeSearchText(item.text).length);
          const startFraction = segment.startOffset / normalizedLength;
          const widthFraction = Math.max(0, segment.endOffset - segment.startOffset) / normalizedLength;
          const marker = documentElement("div", "search-hit");
          marker.classList.toggle("current", index === this.active);
          marker.style.left = `${target.layout.x + (item.x + item.width * startFraction) * target.layout.width / Math.max(1, text.width)}px`;
          marker.style.top = `${target.layout.y + item.y * target.layout.height / Math.max(1, text.height)}px`;
          marker.style.width = `${Math.max(2, item.width * widthFraction * target.layout.width / Math.max(1, text.width))}px`;
          marker.style.height = `${Math.max(2, item.height * target.layout.height / Math.max(1, text.height))}px`;
          target.layer.append(marker);
        }
      }
    }
  }

  /** Invalidates in-flight hit drawing and empties the hit layers. */
  invalidateHits(): void {
    this.overlayGeneration += 1;
    this.clearHitLayers();
  }

  private async goTo(index: number): Promise<void> {
    const hit = this.hits[index];
    if (!hit) return;
    await this.context.goToPage(hit.pageNumber);
    await this.refreshHits();
  }

  private renderResults(): void {
    this.elements.results.replaceChildren();
    this.hits.forEach((hit, index) => {
      const item = documentElement("li", "find-result");
      const button = documentElement("button", "find-result-button");
      button.type = "button";
      button.dataset.searchIndex = String(index);
      button.setAttribute("aria-current", String(index === this.active));
      const page = documentElement("strong", "find-result-page");
      page.textContent = `Page ${hit.pageNumber}`;
      const context = documentElement("span", "find-result-context");
      context.textContent = hit.context;
      button.append(page, context);
      item.append(button);
      this.elements.results.append(item);
    });
  }

  private clearHitLayers(): void {
    for (const layer of this.elements.hitLayers) layer.replaceChildren();
  }

  private clearInputTimer(): void {
    if (this.inputTimer !== undefined) window.clearTimeout(this.inputTimer);
    this.inputTimer = undefined;
  }
}

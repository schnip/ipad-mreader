import { PdfDocument } from "./core/doc";
import { decideReadingTap, panelScrollTop, stepPanelMomentum, suppressReaderShortcutWhileTyping } from "./core/chrome";
import { distance, gestureIntent, midpoint, pageSettleMotion, pageTurnDragOffset, pageTurnRelease, pinchCamera } from "./core/gestures";
import type { GestureIntent, PageTurnRelease, TapSample } from "./core/gestures";
import { constrainGridOffset, dragGridOffset, gridOffsetBounds, gridOffsetForPage, gridPageAtPoint, layoutGrid, nearestGridPage, rubberBandDisplacement, shouldRefreshGridWindow, stepGridMomentum, stepGridSpring, visibleGridPages } from "./core/grid";
import type { GridLayout } from "./core/grid";
import { layoutSinglePage, pageWidthZoom } from "./core/layout";
import { adjacentSpreadSlots, constrainContinuousScroll, continuousPageAtViewportCenter, continuousScrollBounds, continuousScrollForPage, hasMeaningfulZoomDelta, layoutContinuous, layoutSpread, nextSpreadPage, normalizeReaderLayout, shouldRefreshContinuousWindow, spreadPageNumbers, stepContinuousMomentum, trackContinuousVelocity, unionPageLayouts, visibleContinuousPages } from "./core/layout";
import type { ContinuousLayout, Insets, PageLayout, ReaderLayout, Size } from "./core/layout";
import { cameraForPagePoint, constrainCamera, moveCamera, normalizedPageCenter, sceneToScreen, screenToScene, zoomCameraAt } from "./core/scene";
import type { Camera, Point } from "./core/scene";
import { SettledPageRenderer, boundedRasterMultiplier } from "./core/render";
import type { PageRenderSpec } from "./core/render";
import { GRID_EXIT_SCALE, GRID_REST_SCALE, MIN_SEMANTIC_SCALE, gridLayerOpacity, interpolateSemanticTransform, readingLayerOpacity, semanticScale, semanticTransitionProgress, semanticViewMode } from "./core/semantic";
import type { SemanticViewMode } from "./core/semantic";
import { ThumbnailRenderer } from "./core/thumbs";
import type { ThumbnailRenderSpec } from "./core/thumbs";
import { isViewControlActive } from "./core/view-controls";
import { flattenOutline, outlineTreeStructure } from "./core/outline";
import type { FlatOutlineItem, OutlineTreeItem, PdfOutlineNode } from "./core/outline";
import { SearchGeneration, normalizeSearchText, searchPages } from "./core/search";
import type { SearchHit, SearchPageText } from "./core/search";
import { DEFAULT_HIGHLIGHT_COLOR, DEFAULT_INK_COLOR, DEFAULT_NOTE_COLOR, annotationMetadata, annotationsForPage, appendInkPoint, characterHitTest, inkSegments, normalizeAnnotation, orderAnnotations, selectionContainsPoint, selectionRangeGeometry } from "./core/annotations";
import type { Annotation, InkPoint, NormalizedPoint, NoteAnnotation, SelectionGeometry, TextPosition } from "./core/annotations";
import { deletePdf, importPdf, listPdfs, readPdf } from "./store/opfs";
import { dedupeRecentDocuments, defaultReadingPosition, deleteDocumentSidecar, listRecentDocuments, putDocumentSidecar, updateReadingPosition } from "./store/sidecar";
import type { DocumentSidecar, FitState, ReadingPosition } from "./store/sidecar";
import { addOpenDocument, closeOpenDocument, emptyOpenSession, loadOpenSession, normalizeOpenSession, saveOpenSession, selectOpenDocument } from "./store/session";
import type { OpenDocumentSession } from "./store/session";
import { deleteAnnotation, listDocumentAnnotations, putAnnotation } from "./store/annotations";

interface SingleTouch {
  startedAt: number;
  start: Point;
  latest: Point;
  intent: GestureIntent | "grid-pan" | "grid-ignore" | "continuous-pan" | "continuous-ignore";
  lastMovedAt: number;
  pageVelocity: number;
  gridVelocity: number;
  continuousVelocity: number;
}

interface PinchTouch {
  distance: number;
  center: Point;
  camera: Camera;
  semanticScale: number;
  viewMode: SemanticViewMode;
  gridOffset: number;
  focusPage: number;
}

interface CanvasSet {
  previous: HTMLCanvasElement;
  current: HTMLCanvasElement;
  next: HTMLCanvasElement;
}

interface TextSelectionState {
  pageNumber: number;
  pageText: SearchPageText;
  anchorStart: TextPosition;
  anchorEnd: TextPosition;
  start: TextPosition;
  end: TextPosition;
  geometry: SelectionGeometry;
}

interface SelectionTouch {
  mode: "extend" | "start" | "end";
  pageNumber: number;
}

interface InkState {
  pointerId: number;
  documentId: string;
  pageNumber: number;
  startedAt: number;
  points: InkPoint[];
}

interface LiveInkSurface {
  element: SVGSVGElement;
  ink: InkState;
  layout: PageLayout;
  renderedPointCount: number;
}

const TAP_MOVEMENT = 10;
const SELECTION_TOUCH_PAD = 0.012;
const INK_BASE_WIDTH = 2.2;
export class ReaderApplication {
  private readonly scene: HTMLElement;
  private readonly track: HTMLElement;
  private readonly gridLayer: HTMLElement;
  private readonly continuousLayer: HTMLElement;
  private readonly pageHitLayer: HTMLElement;
  private readonly continuousHitLayer: HTMLElement;
  private readonly pageAnnotationLayer: HTMLElement;
  private readonly continuousAnnotationLayer: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly status: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly chromeBackdrop: HTMLElement;
  private readonly panelBackdrop: HTMLElement;
  private readonly topBar: HTMLElement;
  private readonly bottomBar: HTMLElement;
  private readonly documentTabs: HTMLElement;
  private readonly findPanel: HTMLElement;
  private readonly findInput: HTMLInputElement;
  private readonly findResults: HTMLElement;
  private readonly findSummary: HTMLElement;
  private readonly morePanel: HTMLElement;
  private readonly drawerPanel: HTMLElement;
  private readonly drawerTitle: HTMLElement;
  private readonly drawerContent: HTMLElement;
  private readonly selectionActions: HTMLElement;
  private readonly annotationEditor: HTMLElement;
  private readonly annotationText: HTMLTextAreaElement;
  private canvases: CanvasSet;
  private readonly renderer = new SettledPageRenderer();
  private readonly thumbnailRenderer = new ThumbnailRenderer();
  private document?: PdfDocument;
  private sidecar?: DocumentSidecar;
  private page = 1;
  private camera: Camera = { x: 0, y: 0, scale: 1 };
  private fit: FitState = "page";
  private currentLayout?: PageLayout;
  private readonly layouts = new Map<number, PageLayout>();
  private layoutMode: ReaderLayout = "single";
  private readonly spreadCanvases = new Map<number, HTMLCanvasElement>();
  private continuousLayout?: ContinuousLayout;
  private continuousScroll = 0;
  private continuousSyncedScroll = Number.NaN;
  private readonly continuousCanvases = new Map<number, HTMLCanvasElement>();
  private continuousMomentumFrame?: number;
  private gridLayout?: GridLayout;
  private pageSizes: Size[] = [];
  private readonly thumbnailCanvases = new Map<number, HTMLCanvasElement>();
  private gridPreparation?: Promise<void>;
  private gridGeneration = 0;
  private gridSizesReady = false;
  private gridOffset = 0;
  private gridOverscroll = 0;
  private gridBounce = 0;
  private gridSyncedOffset = Number.NaN;
  private gridMomentumFrame?: number;
  private gridGesture?: Camera;
  private gridFocusPage = 1;
  private viewMode: SemanticViewMode = "reading";
  private semanticZoom = 1;
  private singleTouch?: SingleTouch;
  private bufferedPageTouch?: SingleTouch;
  private queuedPageTurn?: PageTurnRelease;
  private pinchTouch?: PinchTouch;
  private previousTap?: TapSample;
  private pendingChromeTimer?: number;
  private chromeVisible = false;
  private swipeOffset = 0;
  private animating = false;
  private pageTurnSettling = false;
  private pageTurnGeneration = 0;
  private opening = false;
  private viewGeneration = 0;
  private persistenceTimer?: number;
  private statusTimer?: number;
  private resizeFrame?: number;
  private readonly penPointers = new Set<number>();
  private suppressTouchesUntil = 0;
  private openSession: OpenDocumentSession = emptyOpenSession();
  private readonly openSidecars = new Map<string, DocumentSidecar>();
  private recentSidecars: DocumentSidecar[] = [];
  private readonly searchGenerations = new SearchGeneration();
  private searchInputTimer?: number;
  private searchHits: SearchHit[] = [];
  private activeSearchHit = -1;
  private hitOverlayGeneration = 0;
  private outlineNodes?: PdfOutlineNode[];
  private flatOutline: FlatOutlineItem[] = [];
  private panelScrollTouch?: { element: HTMLElement; lastY: number; lastAt: number; velocity: number };
  private panelMomentumFrame?: number;
  private annotations: Annotation[] = [];
  private annotationGeneration = 0;
  private annotationOverlayGeneration = 0;
  private selection?: TextSelectionState;
  private selectionTouch?: SelectionTouch;
  private pendingSelectionDismissal?: TextSelectionState;
  private readonly selectionHandles = new Map<"start" | "end", HTMLButtonElement>();
  private longPressTimer?: number;
  private longPressGeneration = 0;
  private ink?: InkState;
  private liveInkSurface?: LiveInkSurface;
  private editingNoteId?: string;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = this.markup();
    this.scene = required(root, "#reader-scene");
    this.track = required(root, "#page-track");
    this.gridLayer = required(root, "#thumbnail-grid");
    this.continuousLayer = required(root, "#continuous-pages");
    this.pageHitLayer = required(root, "#page-hit-layer");
    this.continuousHitLayer = required(root, "#continuous-hit-layer");
    this.pageAnnotationLayer = required(root, "#page-annotation-layer");
    this.continuousAnnotationLayer = required(root, "#continuous-annotation-layer");
    this.emptyState = required(root, "#empty-state");
    this.status = required(root, "#reader-status");
    this.fileInput = required(root, "#file-input");
    this.chromeBackdrop = required(root, "#chrome-backdrop");
    this.panelBackdrop = required(root, "#panel-backdrop");
    this.topBar = required(root, "#top-bar");
    this.bottomBar = required(root, "#bottom-bar");
    this.documentTabs = required(root, "#document-tabs");
    this.findPanel = required(root, "#find-panel");
    this.findInput = required(root, "#find-query");
    this.findResults = required(root, "#find-results");
    this.findSummary = required(root, "#find-summary");
    this.morePanel = required(root, "#more-panel");
    this.drawerPanel = required(root, "#drawer-panel");
    this.drawerTitle = required(root, "#drawer-title");
    this.drawerContent = required(root, "#drawer-content");
    this.selectionActions = required(root, "#selection-actions");
    this.annotationEditor = required(root, "#annotation-editor");
    this.annotationText = required(root, "#annotation-text");
    this.canvases = {
      previous: required(root, "#previous-page"),
      current: required(root, "#current-page"),
      next: required(root, "#next-page")
    };
    this.installEvents();
  }

  async start(): Promise<void> {
    this.installHistoryDefense();
    void this.registerServiceWorker();
    await this.restoreSession();
  }

  private markup(): string {
    return `
      <main class="reader-shell" data-build="${__BUILD_NUMBER__}">
        <section id="reader-scene" class="reader-scene" aria-label="PDF reader">
          <div id="page-track" class="page-track">
            <canvas id="previous-page" class="pdf-page" aria-hidden="true" hidden></canvas>
            <canvas id="current-page" class="pdf-page" aria-label="Current PDF page" hidden></canvas>
            <canvas id="next-page" class="pdf-page" aria-hidden="true" hidden></canvas>
            <div id="page-annotation-layer" class="annotation-layer" aria-label="Page annotations"></div>
            <div id="page-hit-layer" class="hit-layer" aria-hidden="true"></div>
          </div>
          <div id="continuous-pages" class="continuous-pages" role="group" aria-label="Continuous PDF pages" hidden>
            <div id="continuous-annotation-layer" class="annotation-layer" aria-label="Visible page annotations"></div>
            <div id="continuous-hit-layer" class="hit-layer" aria-hidden="true"></div>
          </div>
          <div id="thumbnail-grid" class="thumbnail-grid" role="list" aria-label="PDF pages" hidden></div>
          <div id="empty-state" class="empty-state">
            <strong>mreader</strong>
            <span>PDFs stay on this device.</span>
            <button id="empty-open" type="button">Open PDF</button>
            <small>Build ${__BUILD_NUMBER__}</small>
          </div>
          <div id="chrome-backdrop" class="chrome-backdrop reader-control" data-reader-control aria-label="Hide reader controls" role="button" hidden></div>
          <div id="panel-backdrop" class="panel-backdrop reader-control" data-reader-control aria-label="Close panel" role="button" hidden></div>
          <header id="top-bar" class="reader-bar top-bar reader-control" data-reader-control aria-label="Open documents" hidden>
            <div id="document-tabs" class="document-tabs" role="tablist" aria-label="Open PDFs"></div>
            <button id="bar-open" class="bar-action" type="button" aria-label="Open another PDF">Open</button>
          </header>
          <nav id="bottom-bar" class="reader-bar bottom-bar reader-control" data-reader-control aria-label="Reader views" hidden>
            <button type="button" data-view="page" aria-label="Show page view">Page</button>
            <button type="button" data-view="grid" aria-label="Show thumbnail grid">Grid</button>
             <button id="find-open" type="button" aria-label="Find in document">Find</button>
             <button id="more-open" type="button" aria-label="More reader actions" aria-haspopup="dialog">More</button>
          </nav>
          <section id="find-panel" class="reader-panel find-panel reader-control" data-reader-control role="search" aria-label="Find in document" hidden>
            <form id="find-form">
              <input id="find-query" type="search" autocomplete="off" enterkeyhint="search" aria-label="Search text" placeholder="Find in document" />
              <button type="submit">Search</button>
              <button id="find-close" type="button" aria-label="Close Find">Close</button>
            </form>
            <div class="find-navigation">
              <button id="find-previous" type="button" aria-label="Previous search result">Previous</button>
              <button id="find-next" type="button" aria-label="Next search result">Next</button>
              <span id="find-summary" role="status" aria-live="polite">Enter text to search.</span>
            </div>
            <ol id="find-results" class="panel-list" aria-label="Search results"></ol>
          </section>
          <section id="more-panel" class="reader-panel more-panel reader-control" data-reader-control role="dialog" aria-modal="false" aria-label="More reader actions" hidden>
            <header><strong>Layout</strong><button id="more-close" type="button" aria-label="Close More">Close</button></header>
            <div class="layout-options" role="radiogroup" aria-label="Page layout">
              <button type="button" role="radio" data-layout="single">Single page</button>
              <button type="button" role="radio" data-layout="twoUp">Two pages</button>
              <button type="button" role="radio" data-layout="twoUpCover">Two pages with cover</button>
              <button type="button" role="radio" data-layout="continuous">Continuous</button>
            </div>
            <div class="more-actions">
              <button id="outline-open" type="button">Outline</button>
              <button id="recents-open" type="button">Recents</button>
              <button id="annotations-open" type="button">Annotations</button>
            </div>
          </section>
          <section id="drawer-panel" class="reader-panel drawer-panel reader-control" data-reader-control role="dialog" aria-modal="false" aria-labelledby="drawer-title" hidden>
            <header><strong id="drawer-title"></strong><button id="drawer-close" type="button" aria-label="Close drawer">Close</button></header>
            <div id="drawer-content" class="drawer-content"></div>
          </section>
          <div id="selection-actions" class="selection-actions reader-control" data-reader-control role="toolbar" aria-label="Text selection actions" hidden>
            <button id="selection-copy" type="button">Copy</button>
            <button id="selection-highlight" type="button">Highlight</button>
            <button id="selection-note" type="button">Add note</button>
            <button id="selection-cancel" type="button">Cancel</button>
          </div>
          <section id="annotation-editor" class="reader-panel annotation-editor reader-control" data-reader-control role="dialog" aria-modal="true" aria-labelledby="annotation-editor-title" hidden>
            <header><strong id="annotation-editor-title">Note</strong><button id="annotation-editor-close" type="button" aria-label="Close note editor">Close</button></header>
            <textarea id="annotation-text" maxlength="50000" aria-label="Note text" placeholder="Add a note"></textarea>
            <footer><button id="annotation-save" type="button">Save note</button><button id="annotation-cancel" type="button">Cancel</button></footer>
          </section>
          <button id="corner-open" class="corner-open" type="button" aria-label="Open another PDF" title="Open PDF · build ${__BUILD_NUMBER__}"><span></span></button>
          <div id="reader-status" class="reader-status" role="status" aria-live="polite" hidden></div>
          <div id="safe-area-measure" class="safe-area-measure" aria-hidden="true"></div>
          <input id="file-input" type="file" accept="application/pdf,.pdf" hidden />
        </section>
      </main>
    `;
  }

  private installEvents(): void {
    required<HTMLButtonElement>(this.root, "#empty-open").addEventListener("click", () => this.fileInput.click());
    required<HTMLButtonElement>(this.root, "#corner-open").addEventListener("click", () => this.fileInput.click());
    required<HTMLButtonElement>(this.root, "#bar-open").addEventListener("click", () => this.fileInput.click());
    this.chromeBackdrop.addEventListener("click", () => this.setChromeVisible(false));
    this.panelBackdrop.addEventListener("click", () => this.closePanels());
    this.bottomBar.addEventListener("click", (event) => void this.onViewControl(event));
    required<HTMLButtonElement>(this.root, "#find-open").addEventListener("click", () => this.openFind());
    required<HTMLButtonElement>(this.root, "#more-open").addEventListener("click", () => this.openMore());
    required<HTMLButtonElement>(this.root, "#find-close").addEventListener("click", () => this.closePanels());
    required<HTMLButtonElement>(this.root, "#more-close").addEventListener("click", () => this.closePanels());
    required<HTMLButtonElement>(this.root, "#drawer-close").addEventListener("click", () => this.closePanels());
    required<HTMLFormElement>(this.root, "#find-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.runSearch();
    });
    this.findInput.addEventListener("input", () => {
      this.searchGenerations.cancel();
      if (this.searchInputTimer !== undefined) window.clearTimeout(this.searchInputTimer);
      this.searchInputTimer = window.setTimeout(() => {
        this.searchInputTimer = undefined;
        void this.runSearch();
      }, 220);
    });
    required<HTMLButtonElement>(this.root, "#find-previous").addEventListener("click", () => void this.moveSearchHit(-1));
    required<HTMLButtonElement>(this.root, "#find-next").addEventListener("click", () => void this.moveSearchHit(1));
    this.findResults.addEventListener("click", (event) => void this.selectSearchResult(event));
    this.morePanel.addEventListener("click", (event) => void this.onMoreAction(event));
    this.drawerContent.addEventListener("click", (event) => void this.onDrawerAction(event));
    this.pageAnnotationLayer.addEventListener("click", (event) => this.onAnnotationLayerAction(event));
    this.continuousAnnotationLayer.addEventListener("click", (event) => this.onAnnotationLayerAction(event));
    required<HTMLButtonElement>(this.root, "#selection-copy").addEventListener("click", () => void this.copySelection());
    required<HTMLButtonElement>(this.root, "#selection-highlight").addEventListener("click", () => void this.createHighlight());
    required<HTMLButtonElement>(this.root, "#selection-note").addEventListener("click", () => this.openNoteEditor());
    required<HTMLButtonElement>(this.root, "#selection-cancel").addEventListener("click", () => this.cancelSelection());
    required<HTMLButtonElement>(this.root, "#annotation-editor-close").addEventListener("click", () => this.closeNoteEditor());
    required<HTMLButtonElement>(this.root, "#annotation-cancel").addEventListener("click", () => this.closeNoteEditor());
    required<HTMLButtonElement>(this.root, "#annotation-save").addEventListener("click", () => void this.saveNote());
    this.documentTabs.addEventListener("click", (event) => void this.onDocumentTab(event));
    for (const control of [this.chromeBackdrop, this.panelBackdrop, this.topBar, this.bottomBar, this.findPanel, this.morePanel, this.drawerPanel, this.selectionActions, this.annotationEditor]) {
      for (const eventName of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
        control.addEventListener(eventName, (event) => {
          const touchEvent = event as TouchEvent;
          const scrollable = event.target instanceof Element
            ? event.target.closest<HTMLElement>(".panel-list,.drawer-content")
            : null;
          if (eventName === "touchstart") {
            this.cancelContinuousMomentum();
            this.cancelPanelMomentum();
            const touch = touchEvent.touches[0];
            this.panelScrollTouch = scrollable && touchEvent.touches.length === 1 && touch
              ? { element: scrollable, lastY: touch.clientY, lastAt: performance.now(), velocity: 0 }
              : undefined;
          } else if (eventName === "touchmove") {
            event.preventDefault();
            const touch = touchEvent.touches[0];
            const tracked = this.panelScrollTouch;
            if (touch && tracked && touchEvent.touches.length === 1) {
              const now = performance.now();
              const delta = touch.clientY - tracked.lastY;
              const elapsed = Math.max(1, now - tracked.lastAt);
              tracked.element.scrollTop = panelScrollTop(
                tracked.element.scrollTop,
                delta,
                tracked.element.scrollHeight,
                tracked.element.clientHeight
              );
              tracked.velocity = tracked.velocity * 0.65 + (-delta / elapsed) * 0.35;
              tracked.lastY = touch.clientY;
              tracked.lastAt = now;
            }
          } else {
            const tracked = this.panelScrollTouch;
            this.panelScrollTouch = undefined;
            if (eventName === "touchend" && tracked) this.startPanelMomentum(tracked.element, tracked.velocity);
          }
          event.stopPropagation();
        }, { passive: false });
      }
    }
    this.fileInput.addEventListener("change", () => void this.importSelected());
    this.scene.addEventListener("touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.scene.addEventListener("touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.scene.addEventListener("touchend", (event) => void this.onTouchEnd(event), { passive: false });
    this.scene.addEventListener("touchcancel", (event) => this.onTouchCancel(event), { passive: false });
    this.scene.addEventListener("pointerdown", (event) => this.onPointerDown(event), { capture: true });
    this.scene.addEventListener("pointermove", (event) => this.onPointerMove(event), { capture: true });
    this.scene.addEventListener("pointerup", (event) => void this.onPointerEnd(event, false), { capture: true });
    this.scene.addEventListener("pointercancel", (event) => void this.onPointerEnd(event, true), { capture: true });
    for (const layer of [this.pageAnnotationLayer, this.continuousAnnotationLayer]) {
      layer.addEventListener("touchstart", (event) => this.onSelectionHandleStart(event), { passive: false });
    }
    for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
      this.scene.addEventListener(name, (event) => event.preventDefault(), { passive: false });
    }
    window.addEventListener("resize", () => this.queueResize());
    window.addEventListener("pagehide", () => void this.flushPosition());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.flushPosition();
    });
    window.addEventListener("keydown", (event) => void this.onKeyDown(event));
  }

  private async importSelected(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = "";
    if (!file || this.opening) return;
    this.opening = true;
    this.showStatus(`Importing ${file.name}…`);
    let storedId: string | undefined;
    let sidecarStored = false;
    let pendingDocument: PdfDocument | undefined;
    try {
      if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        throw new Error("Choose a PDF file.");
      }
      void navigator.storage.persist?.().catch(() => false);
      const stored = await importPdf(file);
      storedId = stored.id;
      const bytes = await readPdf(stored.id);
      const nextDocument = await PdfDocument.open(bytes, { id: stored.id, name: file.name, byteLength: stored.size });
      pendingDocument = nextDocument;
      const now = Date.now();
      const sidecar: DocumentSidecar = {
        id: stored.id,
        name: file.name,
        byteLength: stored.size,
        pageCount: nextDocument.pageCount,
        importedAt: now,
        lastOpenedAt: now,
        position: defaultReadingPosition(),
        fingerprint: nextDocument.fingerprint
      };
      await putDocumentSidecar(sidecar);
      sidecarStored = true;
      this.recentSidecars = dedupeRecentDocuments([sidecar, ...this.recentSidecars.filter((item) => item.id !== sidecar.id)]);
      pendingDocument = undefined;
      await this.activate(nextDocument, sidecar);
      this.openSidecars.set(sidecar.id, sidecar);
      this.openSession = addOpenDocument(this.openSession, sidecar.id);
      await saveOpenSession(this.openSession).catch((error) => console.warn("Unable to persist open document session", error));
      this.renderChrome();
      storedId = undefined;
      this.showStatus(`${file.name} imported`, false, 1800);
    } catch (error) {
      this.showStatus(errorMessage(error), true);
      await pendingDocument?.destroy().catch(() => undefined);
      if (storedId) {
        await Promise.allSettled([
          deletePdf(storedId),
          sidecarStored ? deleteDocumentSidecar(storedId) : Promise.resolve()
        ]);
      }
    } finally {
      this.opening = false;
    }
  }

  private async restoreSession(): Promise<void> {
    try {
      const [storedPdfs, recents, persistedSession] = await Promise.all([
        listPdfs(),
        listRecentDocuments(),
        loadOpenSession().catch((error) => {
          console.warn("Unable to read open document session", error);
          return undefined;
        })
      ]);
      const storedIds = new Set(storedPdfs.map((file) => file.id));
      const validSidecars = recents.filter((sidecar) => storedIds.has(sidecar.id));
      this.recentSidecars = dedupeRecentDocuments(recents);
      const validIds = new Set(validSidecars.map((sidecar) => sidecar.id));
      this.openSession = persistedSession === undefined
        ? validSidecars[0] ? addOpenDocument(emptyOpenSession(), validSidecars[0].id) : emptyOpenSession()
        : normalizeOpenSession(persistedSession, validIds);
      this.openSidecars.clear();
      for (const sidecar of validSidecars) {
        if (this.openSession.documentIds.includes(sidecar.id)) this.openSidecars.set(sidecar.id, sidecar);
      }
      await saveOpenSession(this.openSession).catch((error) => console.warn("Unable to normalize open document session", error));
      this.renderChrome();
      await this.restoreAvailableCurrent();
      this.hideStatus();
    } catch (error) {
      this.showStatus(`Stored reading state is unavailable: ${errorMessage(error)}`, true);
    }
  }

  private async restoreAvailableCurrent(): Promise<void> {
    while (this.openSession.currentId) {
      const id = this.openSession.currentId;
      const sidecar = this.openSidecars.get(id);
      try {
        this.showStatus(`Restoring ${sidecar?.name ?? "PDF"}…`);
        await this.activateStoredDocument(id);
        return;
      } catch (error) {
        console.warn(`Unable to restore stored document ${id}`, error);
        this.openSession = closeOpenDocument(this.openSession, id);
        this.openSidecars.delete(id);
        await saveOpenSession(this.openSession).catch((saveError) => console.warn("Unable to persist repaired session", saveError));
        this.renderChrome();
      }
    }
    await this.closeActiveDocument();
  }

  private async activateStoredDocument(id: string): Promise<void> {
    const sidecar = this.openSidecars.get(id);
    if (!sidecar) throw new Error("The open document metadata is unavailable.");
    const bytes = await readPdf(id);
    const document = await PdfDocument.open(bytes, {
      id,
      name: sidecar.name,
      byteLength: sidecar.byteLength
    });
    await this.activate(document, sidecar);
  }

  private async switchOpenDocument(id: string): Promise<void> {
    if (this.opening || id === this.sidecar?.id || !this.openSession.documentIds.includes(id)) return;
    this.opening = true;
    this.clearPendingTap();
    this.setChromeVisible(false);
    await this.flushPosition();
    const sidecar = this.openSidecars.get(id);
    this.showStatus(`Opening ${sidecar?.name ?? "PDF"}…`);
    try {
      await this.activateStoredDocument(id);
      this.openSession = selectOpenDocument(this.openSession, id);
      this.renderChrome();
      await saveOpenSession(this.openSession).catch((error) => console.warn("Unable to persist selected document", error));
      this.hideStatus();
    } catch (error) {
      this.showStatus(`Unable to open PDF: ${errorMessage(error)}`, true);
    } finally {
      this.opening = false;
    }
  }

  private async closeDocument(id: string): Promise<void> {
    if (this.opening || !this.openSession.documentIds.includes(id)) return;
    this.opening = true;
    const wasCurrent = this.openSession.currentId === id;
    if (wasCurrent) await this.flushPosition();
    this.openSession = closeOpenDocument(this.openSession, id);
    this.openSidecars.delete(id);
    await saveOpenSession(this.openSession).catch((error) => console.warn("Unable to persist closed document session", error));
    this.renderChrome();
    try {
      if (wasCurrent) {
        await this.restoreAvailableCurrent();
        if (this.document) this.hideStatus();
      }
    } finally {
      this.opening = false;
    }
  }

  private async closeActiveDocument(): Promise<void> {
    this.clearPendingTap();
    this.setChromeVisible(false);
    this.closePanels();
    this.cancelTouches();
    this.renderer.cancel();
    this.thumbnailRenderer.cancel();
    this.cancelGridMomentum();
    this.cancelContinuousMomentum();
    this.gridGeneration += 1;
    this.viewGeneration += 1;
    const document = this.document;
    this.document = undefined;
    this.sidecar = undefined;
    this.currentLayout = undefined;
    this.gridLayout = undefined;
    this.continuousLayout = undefined;
    this.layouts.clear();
    this.clearThumbnailElements();
    this.clearLayoutCanvases();
    this.clearSearch();
    this.cancelAnnotationInteraction();
    this.annotationGeneration += 1;
    this.annotations = [];
    for (const canvas of Object.values(this.canvases)) canvas.hidden = true;
    this.gridLayer.hidden = true;
    this.emptyState.hidden = false;
    await document?.destroy().catch(() => undefined);
  }

  private async activate(document: PdfDocument, sidecar: DocumentSidecar): Promise<void> {
    this.clearPendingTap();
    this.setChromeVisible(false);
    this.closePanels();
    this.cancelTouches();
    this.clearSearch();
    this.cancelAnnotationInteraction();
    this.outlineNodes = undefined;
    this.flatOutline = [];
    const previous = this.document;
    const previousSidecar = this.sidecar;
    const previousPage = this.page;
    const previousCamera = this.camera;
    const previousFit = this.fit;
    const previousLayout = this.currentLayout;
    const previousLayouts = new Map(this.layouts);
    const previousGridLayout = this.gridLayout;
    const previousPageSizes = this.pageSizes;
    const previousGridSizesReady = this.gridSizesReady;
    const previousGridOffset = this.gridOffset;
    const previousGridSyncedOffset = this.gridSyncedOffset;
    const previousGridFocusPage = this.gridFocusPage;
    const previousViewMode = this.viewMode;
    const previousLayoutMode = this.layoutMode;
    const previousContinuousLayout = this.continuousLayout;
    const previousContinuousScroll = this.continuousScroll;
    const previousAnnotations = this.annotations;
    this.renderer.cancel();
    this.thumbnailRenderer.cancel();
    this.cancelGridMomentum();
    this.cancelContinuousMomentum();
    this.gridGeneration += 1;
    this.gridPreparation = undefined;
    this.gridSizesReady = false;
    this.clearThumbnailElements();
    this.clearLayoutCanvases();
    this.document = document;
    this.sidecar = sidecar;
    const annotationGeneration = ++this.annotationGeneration;
    this.annotations = [];
    this.page = Math.min(document.pageCount, Math.max(1, sidecar.position.page));
    this.fit = sidecar.position.fit;
    this.layoutMode = normalizeReaderLayout(sidecar.position.layout);
    this.viewMode = "reading";
    this.semanticZoom = 1;
    this.gridGesture = undefined;
    this.gridLayout = undefined;
    this.continuousLayout = undefined;
    this.continuousScroll = 0;
    this.gridOffset = 0;
    this.gridOverscroll = 0;
    this.gridBounce = 0;
    this.gridSyncedOffset = Number.NaN;
    this.gridFocusPage = this.page;
    this.gridLayer.hidden = true;
    this.layouts.clear();
    let layout: PageLayout;
    try {
      try {
        const annotations = await listDocumentAnnotations(sidecar.id);
        if (annotationGeneration !== this.annotationGeneration || document !== this.document) throw new DOMException("Annotation load superseded.", "AbortError");
        this.annotations = annotations;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        console.warn("Unable to load annotations", error);
      }
      layout = await this.layoutFor(this.page);
      this.currentLayout = layout;
      this.pageSizes = Array.from({ length: document.pageCount }, () => ({ width: layout.width, height: layout.height }));
      if (this.layoutMode !== "single") await this.prepareGrid();
      if (this.layoutMode === "continuous") {
        this.rebuildContinuousLayout();
        if (this.continuousLayout) this.continuousScroll = continuousScrollForPage(this.continuousLayout, this.page, this.viewport());
      }
      this.camera = this.cameraFromPosition(sidecar.position, layout);
      this.applyTransform();
      await this.refreshRendering();
    } catch (error) {
      this.renderer.cancel();
      this.document = previous;
      this.sidecar = previousSidecar;
      this.page = previousPage;
      this.camera = previousCamera;
      this.fit = previousFit;
      this.currentLayout = previousLayout;
      this.gridLayout = previousGridLayout;
      this.pageSizes = previousPageSizes;
      this.gridSizesReady = previousGridSizesReady;
      this.gridOffset = previousGridOffset;
      this.gridSyncedOffset = previousGridSyncedOffset;
      this.gridFocusPage = previousGridFocusPage;
      this.viewMode = previousViewMode;
      this.layoutMode = previousLayoutMode;
      this.continuousLayout = previousContinuousLayout;
      this.continuousScroll = previousContinuousScroll;
      this.annotations = previousAnnotations;
      this.annotationGeneration += 1;
      this.semanticZoom = previousViewMode === "grid" ? GRID_REST_SCALE : 1;
      this.layouts.clear();
      for (const [page, savedLayout] of previousLayouts) this.layouts.set(page, savedLayout);
      this.applyTransform();
      if (previousViewMode === "grid") {
        this.gridLayer.hidden = false;
        this.syncGridThumbnails();
      }
      if (previous) await this.refreshRendering().catch(() => undefined);
      else {
        this.emptyState.hidden = false;
        for (const canvas of Object.values(this.canvases)) canvas.hidden = true;
      }
      await document.destroy().catch(() => undefined);
      throw error;
    }
    this.emptyState.hidden = true;
    this.canvases.current.setAttribute("aria-label", `Page ${this.page} of ${document.pageCount}`);
    sidecar.lastOpenedAt = Date.now();
    sidecar.position = this.readingPosition();
    sidecar.fingerprint ??= document.fingerprint;
    this.recentSidecars = dedupeRecentDocuments([sidecar, ...this.recentSidecars.filter((item) => item.id !== sidecar.id)]);
    await putDocumentSidecar(sidecar).catch((error) => console.warn("Unable to update recent document state", error));
    if (previous && previous !== document) await previous.destroy().catch(() => undefined);
    this.renderChrome();
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    event.preventDefault();
    this.penPointers.add(event.pointerId);
    this.suppressTouchesUntil = Number.POSITIVE_INFINITY;
    this.cancelTouches();
    this.cancelSelection();
    if (this.ink) this.cancelInk();
    if (!this.document || !this.sidecar || this.opening || this.animating || this.viewMode !== "reading" || isControl(event.target)) {
      this.removeLiveInkSurface();
      return;
    }
    const hit = this.pageHitAt({ x: event.clientX, y: event.clientY });
    if (!hit) {
      this.removeLiveInkSurface();
      return;
    }
    this.cancelContinuousMomentum();
    this.ink = { pointerId: event.pointerId, documentId: this.sidecar.id, pageNumber: hit.pageNumber, startedAt: event.timeStamp, points: [] };
    try {
      this.scene.setPointerCapture(event.pointerId);
    } catch {
      this.ink = undefined;
      this.removeLiveInkSurface();
      return;
    }
    this.appendPointerInk(event);
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerType !== "pen" || this.ink?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.appendPointerInk(event);
  }

  private async onPointerEnd(event: PointerEvent, cancelled: boolean): Promise<void> {
    if (event.pointerType !== "pen") return;
    event.preventDefault();
    const ink = this.ink?.pointerId === event.pointerId ? this.ink : undefined;
    if (ink && !cancelled) this.appendPointerInk(event);
    if (ink) this.ink = undefined;
    this.penPointers.delete(event.pointerId);
    if (this.penPointers.size === 0) this.suppressTouchesUntil = performance.now() + 250;
    this.cancelTouches();
    if (!ink) return;
    if (cancelled || ink.points.length < 2 || ink.documentId !== this.sidecar?.id) {
      this.removeLiveInkSurface(ink);
      return;
    }
    const value = normalizeAnnotation({
      ...annotationMetadata(ink.documentId, ink.pageNumber),
      kind: "ink",
      color: DEFAULT_INK_COLOR,
      baseWidth: INK_BASE_WIDTH,
      points: ink.points
    });
    if (value?.kind === "ink") await this.persistAnnotation(value);
    this.removeLiveInkSurface(ink);
  }

  private onTouchStart(event: TouchEvent): void {
    if (!this.document || this.opening || isControl(event.target)) return;
    if (this.penInputActive()) {
      event.preventDefault();
      this.cancelTouches();
      return;
    }
    if (this.animating) {
      this.startBufferedPageTouch(event);
      return;
    }
    if (this.queuedPageTurn) {
      event.preventDefault();
      return;
    }
    this.cancelGridMomentum();
    this.cancelContinuousMomentum();
    this.applyTransform();
    const edgeTouch = [...event.changedTouches].some((touch) => touch.clientX < 28 || touch.clientX > window.innerWidth - 28);
    if (edgeTouch) event.preventDefault();
    if (event.touches.length === 2) {
      event.preventDefault();
      this.cancelSelection();
      this.clearPendingTap();
      const points = touchPoints(event.touches);
      if (!points) return;
      this.pinchTouch = {
        distance: distance(points[0], points[1]),
        center: midpoint(points[0], points[1]),
        camera: { ...this.camera },
        semanticScale: this.viewMode === "grid" ? GRID_REST_SCALE : Math.min(1, this.camera.scale),
        viewMode: this.viewMode,
        gridOffset: this.gridOffset,
        focusPage: this.viewMode === "reading" ? this.focusedReadingPage(midpoint(points[0], points[1])) : this.focusedGridPage(midpoint(points[0], points[1]))
      };
      this.semanticZoom = this.pinchTouch.semanticScale;
      if (this.viewMode === "grid") void this.prepareFocusedPage(this.pinchTouch.focusPage);
      this.ensureGridLayout();
      if (this.viewMode === "reading" && this.gridLayout) {
        this.gridFocusPage = this.pinchTouch.focusPage;
        this.gridOffset = gridOffsetForPage(this.gridLayout, this.gridFocusPage, this.viewport(), this.safeInsets());
      }
      this.gridLayer.hidden = false;
      void this.prepareGrid();
      this.singleTouch = undefined;
      this.swipeOffset = 0;
    } else if (event.touches.length === 1) {
      const point = touchPoint(event.touches[0]);
      if (!point) return;
      if (this.selection) {
        const hit = this.pageHitAt(point);
        const insideSelection = hit?.pageNumber === this.selection.pageNumber
          && selectionContainsPoint(this.selection.geometry, hit.normalized, SELECTION_TOUCH_PAD, SELECTION_TOUCH_PAD);
        if (insideSelection && hit) {
          event.preventDefault();
          this.selectionTouch = { mode: "extend", pageNumber: hit.pageNumber };
          void this.updateSelectionAt(point, "extend");
          return;
        }
        this.pendingSelectionDismissal = this.selection;
      }
      const now = performance.now();
      if (this.pendingChromeTimer !== undefined
        && decideReadingTap(this.previousTap, { at: now, point }, this.viewport()).action === "double-tap") {
        this.clearPendingTap(false);
      }
      this.singleTouch = { startedAt: now, start: point, latest: point, intent: "undecided", lastMovedAt: now, pageVelocity: 0, gridVelocity: 0, continuousVelocity: 0 };
      this.scheduleLongPress(this.singleTouch, point);
    }
  }

  private onTouchMove(event: TouchEvent): void {
    if (!this.document || this.opening) return;
    if (this.penInputActive()) {
      event.preventDefault();
      this.cancelTouches();
      return;
    }
    if (this.animating) {
      this.updateBufferedPageTouch(event);
      return;
    }
    if (this.selectionTouch && event.touches.length === 1) {
      event.preventDefault();
      const point = touchPoint(event.touches[0]);
      if (point) void this.updateSelectionAt(point, this.selectionTouch.mode);
      return;
    }
    if (event.touches.length === 2 && this.pinchTouch && this.currentLayout) {
      event.preventDefault();
      const points = touchPoints(event.touches);
      if (!points) return;
      const center = midpoint(points[0], points[1]);
      const currentDistance = distance(points[0], points[1]);
      if (this.pinchTouch.viewMode === "reading") {
        const requestedScale = this.pinchTouch.camera.scale * currentDistance / Math.max(this.pinchTouch.distance, 1);
        if (requestedScale >= 1 && this.viewMode === "reading") {
          this.camera = pinchCamera(
            this.pinchTouch.camera,
            this.pinchTouch.distance,
            currentDistance,
            this.pinchTouch.center,
            center
          );
          this.semanticZoom = 1;
        } else {
          this.semanticZoom = Math.min(1, Math.max(MIN_SEMANTIC_SCALE, requestedScale));
          this.camera = pinchCamera(
            this.pinchTouch.camera,
            this.pinchTouch.distance,
            currentDistance,
            this.pinchTouch.center,
            center,
            MIN_SEMANTIC_SCALE
          );
          this.updateGridCameraFromReadingPinch(this.pinchTouch.focusPage);
          const nextMode = semanticViewMode(this.viewMode, this.semanticZoom);
          if (nextMode === "grid" && this.viewMode !== "grid") this.enterGridDuringPinch(this.pinchTouch.focusPage);
          this.viewMode = nextMode;
        }
      } else {
        this.semanticZoom = semanticScale(
          this.pinchTouch.semanticScale,
          this.pinchTouch.distance,
          currentDistance
        );
        const scale = this.semanticZoom / this.pinchTouch.semanticScale;
        this.gridGesture = {
          scale,
          x: center.x - ((this.pinchTouch.center.x - this.pinchTouch.gridOffset) * scale),
          y: center.y - (this.pinchTouch.center.y * scale)
        };
        this.viewMode = semanticViewMode(this.viewMode, this.semanticZoom);
        this.updateReadingCameraFromGridPinch(this.pinchTouch.focusPage);
      }
      this.applyTransform();
      return;
    }
    if (event.touches.length !== 1 || !this.singleTouch || !this.currentLayout) return;
    event.preventDefault();
    const current = touchPoint(event.touches[0]);
    if (!current) return;
    const previous = this.singleTouch.latest;
    const movedAt = performance.now();
    const movedIn = Math.max(1, movedAt - this.singleTouch.lastMovedAt);
    const delta = { x: current.x - this.singleTouch.start.x, y: current.y - this.singleTouch.start.y };
    if (Math.hypot(delta.x, delta.y) >= 8) {
      this.clearPendingTap();
      this.cancelLongPress();
      this.applyPendingSelectionDismissal();
    }
    this.singleTouch.latest = current;
    this.singleTouch.lastMovedAt = movedAt;
    if (this.viewMode === "grid") {
      if (this.singleTouch.intent === "undecided" && Math.hypot(delta.x, delta.y) >= 8) {
        this.singleTouch.intent = Math.abs(delta.x) > Math.abs(delta.y) * 1.15 ? "grid-pan" : "grid-ignore";
      }
      if (this.singleTouch.intent === "grid-pan" && this.gridLayout) {
        const instantaneousVelocity = (current.x - previous.x) / movedIn;
        this.singleTouch.gridVelocity = this.singleTouch.gridVelocity * 0.65 + instantaneousVelocity * 0.35;
        const reducedMotion = this.reducedMotion();
        const dragged = dragGridOffset(
          this.gridOffset,
          reducedMotion ? 0 : this.gridOverscroll,
          current.x - previous.x,
          gridOffsetBounds(this.gridLayout, this.viewport(), this.safeInsets())
        );
        this.gridOffset = dragged.legalOffset;
        this.gridOverscroll = reducedMotion ? 0 : dragged.overscroll;
        this.gridBounce = reducedMotion ? 0 : dragged.visualOffset - dragged.legalOffset;
        if (shouldRefreshGridWindow(this.gridOffset, this.gridSyncedOffset, this.viewport().width)) {
          this.syncGridThumbnails();
        }
      }
      this.applyTransform();
      return;
    }
    if (this.layoutMode === "continuous" && this.continuousLayout) {
      if (this.singleTouch.intent === "undecided" && Math.hypot(delta.x, delta.y) >= 8) {
        this.singleTouch.intent = Math.abs(delta.y) > Math.abs(delta.x) * 1.15 ? "continuous-pan" : "continuous-ignore";
      }
      if (this.singleTouch.intent === "continuous-pan") {
        const bounds = continuousScrollBounds(this.continuousLayout, this.viewport());
        const scrollDelta = -(current.y - previous.y);
        this.singleTouch.continuousVelocity = trackContinuousVelocity(this.singleTouch.continuousVelocity, scrollDelta, movedIn);
        this.continuousScroll = constrainContinuousScroll(this.continuousScroll + scrollDelta, bounds);
        this.syncContinuousFocus();
        this.applyTransform();
        if (shouldRefreshContinuousWindow(this.continuousScroll, this.continuousSyncedScroll, this.viewport().height)) {
          void this.refreshContinuousRendering();
        }
      }
      return;
    }
    if (this.singleTouch.intent === "undecided") this.singleTouch.intent = gestureIntent(delta, this.camera.scale);
    if (this.singleTouch.intent === "page-turn") {
      const instantaneousVelocity = (current.x - previous.x) / movedIn;
      this.singleTouch.pageVelocity = this.singleTouch.pageVelocity * 0.55 + instantaneousVelocity * 0.45;
      this.swipeOffset = pageTurnDragOffset(delta.x, this.hasPage(delta.x < 0 ? 1 : -1));
    } else if (this.singleTouch.intent === "pan") {
      this.fit = "custom";
      this.camera = constrainCamera(
        moveCamera(this.camera, { x: current.x - previous.x, y: current.y - previous.y }),
        this.cameraBoundsLayout() ?? this.currentLayout,
        this.viewport(),
        this.safeInsets()
      );
    }
    this.applyTransform();
  }

  private async onTouchEnd(event: TouchEvent): Promise<void> {
    if (!this.document || this.opening) return;
    if (this.penInputActive()) {
      event.preventDefault();
      this.cancelTouches();
      return;
    }
    if (this.bufferedPageTouch) {
      this.finishBufferedPageTouch(event);
      return;
    }
    if (this.selectionTouch) {
      event.preventDefault();
      if (event.touches.length === 0) this.selectionTouch = undefined;
      return;
    }
    if (this.animating) return;
    if (event.touches.length > 0) return;
    if (this.pinchTouch && this.currentLayout) {
      event.preventDefault();
      const startedIn = this.pinchTouch.viewMode;
      const focusPage = this.pinchTouch.focusPage;
      this.pinchTouch = undefined;
      this.gridGesture = undefined;
      if (this.viewMode === "grid") {
        const settleMilliseconds = this.semanticSettleDuration();
        this.gridLayer.classList.add("semantic-settling");
        this.track.classList.add("semantic-settling");
        this.semanticZoom = GRID_REST_SCALE;
        this.camera = { x: 0, y: 0, scale: 1 };
        this.fit = "page";
        if (this.gridLayout) {
          this.gridOffset = constrainGridOffset(this.gridOffset, this.gridLayout, this.viewport(), this.safeInsets());
        }
        this.applyTransform();
        this.syncGridThumbnails();
        await Promise.all([
          this.prepareFocusedPage(this.focusedGridPage({ x: this.viewport().width / 2, y: this.viewport().height / 2 })),
          wait(settleMilliseconds)
        ]);
        this.gridLayer.classList.remove("semantic-settling");
        this.track.classList.remove("semantic-settling");
      } else if (startedIn === "grid") {
        await this.exitGrid(focusPage);
      } else {
        this.focusSpreadPage(focusPage);
        this.camera = constrainCamera(this.camera, this.cameraBoundsLayout() ?? this.currentLayout, this.viewport(), this.safeInsets());
        if (this.camera.scale <= 1.01) this.setPageFit();
        else this.fit = "custom";
        this.semanticZoom = 1;
        this.applyTransform();
        await this.refreshRendering();
        this.gridLayer.hidden = true;
        this.queuePositionSave();
      }
      return;
    }
    const touch = this.singleTouch;
    if (!touch) return;
    this.cancelLongPress();
    event.preventDefault();
    this.singleTouch = undefined;
    const dismissedSelection = this.applyPendingSelectionDismissal();
    const deltaX = touch.latest.x - touch.start.x;
    const deltaY = touch.latest.y - touch.start.y;
    const endedAt = performance.now();
    const elapsedMs = endedAt - touch.startedAt;
    const release = pageTurnRelease(
      { deltaX, deltaY, elapsedMs, viewportWidth: this.scene.clientWidth },
      touch.pageVelocity,
      endedAt - touch.lastMovedAt
    );
    if (this.viewMode === "grid") {
      if (touch.intent === "undecided" && distance(touch.start, touch.latest) <= TAP_MOVEMENT && elapsedMs < 400) {
        const selected = this.gridLayout ? gridPageAtPoint(this.gridLayout, this.gridOffset, touch.latest) : undefined;
        if (selected) await this.exitGrid(selected);
      } else if (touch.intent === "grid-pan") {
        if (Math.abs(this.gridBounce) > 0.01) {
          this.startGridSpring(touch.gridVelocity);
        } else if (!this.startGridMomentum(touch.gridVelocity)) {
          this.syncGridThumbnails();
          await this.prepareFocusedPage(this.focusedGridPage({ x: this.viewport().width / 2, y: this.viewport().height / 2 }));
        }
      }
      return;
    }
    if (this.layoutMode === "continuous") {
      if (touch.intent === "undecided" && distance(touch.start, touch.latest) <= TAP_MOVEMENT && elapsedMs < 400) {
        if (!dismissedSelection) await this.handleTap({ at: performance.now(), point: touch.latest });
      } else if (touch.intent === "continuous-pan") {
        if (!this.startContinuousMomentum(touch.continuousVelocity)) {
          await this.refreshContinuousRendering();
          this.queuePositionSave();
        }
      }
      return;
    }
    if (touch.intent === "undecided" && distance(touch.start, touch.latest) <= TAP_MOVEMENT && elapsedMs < 400) {
      if (!dismissedSelection) await this.handleTap({ at: performance.now(), point: touch.latest });
      return;
    }
    const direction = touch.intent === "page-turn" ? release.direction : 0;
    if (direction === 0 || !this.hasPage(direction)) {
      await this.settleSwipeBack(release.releaseVelocity);
      if (touch.intent === "pan") this.queuePositionSave();
      return;
    }
    await this.turnPage(direction, release.releaseVelocity);
  }

  private onTouchCancel(event: TouchEvent): void {
    if (this.singleTouch || this.bufferedPageTouch || this.pinchTouch) event.preventDefault();
    this.cancelTouches();
    this.cancelLongPress();
    this.selectionTouch = undefined;
    this.pendingSelectionDismissal = undefined;
  }

  private startBufferedPageTouch(event: TouchEvent): void {
    if (!this.pageTurnSettling
      || this.bufferedPageTouch
      || this.queuedPageTurn
      || this.viewMode !== "reading"
      || this.layoutMode === "continuous"
      || this.camera.scale > 1.01) return;
    if (event.touches.length !== 1) {
      this.bufferedPageTouch = undefined;
      return;
    }
    const point = touchPoint(event.touches[0]);
    if (!point) return;
    event.preventDefault();
    const now = performance.now();
    this.bufferedPageTouch = {
      startedAt: now,
      start: point,
      latest: point,
      intent: "undecided",
      lastMovedAt: now,
      pageVelocity: 0,
      gridVelocity: 0,
      continuousVelocity: 0
    };
  }

  private updateBufferedPageTouch(event: TouchEvent): void {
    const touch = this.bufferedPageTouch;
    if (!touch) return;
    if (!this.pageTurnSettling || event.touches.length !== 1) {
      this.bufferedPageTouch = undefined;
      return;
    }
    event.preventDefault();
    const current = touchPoint(event.touches[0]);
    if (!current) return;
    const previous = touch.latest;
    const movedAt = performance.now();
    const movedIn = Math.max(1, movedAt - touch.lastMovedAt);
    const delta = { x: current.x - touch.start.x, y: current.y - touch.start.y };
    touch.latest = current;
    touch.lastMovedAt = movedAt;
    if (Math.hypot(delta.x, delta.y) < 8) return;
    if (Math.abs(delta.x) <= Math.abs(delta.y) * 1.15) {
      this.bufferedPageTouch = undefined;
      return;
    }
    touch.intent = "page-turn";
    const instantaneousVelocity = (current.x - previous.x) / movedIn;
    touch.pageVelocity = touch.pageVelocity * 0.55 + instantaneousVelocity * 0.45;
  }

  private finishBufferedPageTouch(event: TouchEvent): void {
    if (event.touches.length > 0) {
      this.bufferedPageTouch = undefined;
      return;
    }
    event.preventDefault();
    const touch = this.bufferedPageTouch;
    this.bufferedPageTouch = undefined;
    if (!touch || !this.pageTurnSettling || touch.intent !== "page-turn" || this.queuedPageTurn) return;
    const endedAt = performance.now();
    const release = pageTurnRelease(
      {
        deltaX: touch.latest.x - touch.start.x,
        deltaY: touch.latest.y - touch.start.y,
        elapsedMs: endedAt - touch.startedAt,
        viewportWidth: this.scene.clientWidth
      },
      touch.pageVelocity,
      endedAt - touch.lastMovedAt
    );
    if (release.direction !== 0) this.queuedPageTurn = release;
  }

  private async handleTap(tap: TapSample): Promise<void> {
    if (this.viewMode === "grid") return;
    const decision = decideReadingTap(this.previousTap, tap, this.viewport());
    if (decision.cancelPending) this.clearPendingTap(false);
    if (decision.action === "double-tap") {
      this.previousTap = undefined;
      await this.togglePageWidth(tap.point);
      return;
    }
    this.previousTap = tap;
    if (decision.action === "remember") return;
    const deferredAction = decision.action;
    this.pendingChromeTimer = window.setTimeout(() => {
      this.pendingChromeTimer = undefined;
      if (this.previousTap === tap && this.viewMode === "reading" && this.document) {
        this.previousTap = undefined;
        if (deferredAction === "defer-chrome") this.setChromeVisible(!this.chromeVisible);
        else void this.navigateFromEdgeTap(deferredAction === "defer-next-page" ? 1 : -1);
      }
    }, 330);
  }

  private async navigateFromEdgeTap(direction: -1 | 1): Promise<void> {
    if (!this.document || this.animating || this.opening || !this.hasPage(direction)) return;
    if (this.layoutMode !== "continuous") {
      await this.turnPage(direction);
      return;
    }
    this.setChromeVisible(false);
    this.animating = true;
    try {
      await this.goToPage(this.page + direction);
    } finally {
      this.animating = false;
    }
  }

  private clearPendingTap(clearSample = true): void {
    if (this.pendingChromeTimer !== undefined) window.clearTimeout(this.pendingChromeTimer);
    this.pendingChromeTimer = undefined;
    if (clearSample) this.previousTap = undefined;
  }

  private setChromeVisible(visible: boolean): void {
    this.chromeVisible = visible && this.document !== undefined;
    this.renderChrome();
  }

  private renderChrome(): void {
    const shown = this.chromeVisible && this.document !== undefined;
    this.topBar.hidden = this.document === undefined;
    this.bottomBar.hidden = this.document === undefined;
    this.topBar.classList.toggle("visible", shown);
    this.bottomBar.classList.toggle("visible", shown);
    this.topBar.setAttribute("aria-hidden", String(!shown));
    this.bottomBar.setAttribute("aria-hidden", String(!shown));
    this.chromeBackdrop.hidden = !shown;
    this.root.classList.toggle("chrome-visible", shown);
    this.documentTabs.replaceChildren();
    for (const id of this.openSession.documentIds) {
      const sidecar = this.openSidecars.get(id);
      if (!sidecar) continue;
      const wrapper = documentElement("div", "document-tab");
      const select = documentElement("button", "document-select");
      select.type = "button";
      select.dataset.documentId = id;
      select.textContent = sidecar.name;
      select.title = sidecar.name;
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(this.openSession.currentId === id));
      const close = documentElement("button", "document-close");
      close.type = "button";
      close.dataset.closeDocument = id;
      close.textContent = "×";
      close.setAttribute("aria-label", `Close ${sidecar.name} from this session`);
      wrapper.append(select, close);
      this.documentTabs.append(wrapper);
    }
    for (const button of this.bottomBar.querySelectorAll<HTMLButtonElement>("button[data-view]")) {
      const control = button.dataset.view;
      if (control !== "page" && control !== "grid") continue;
      const active = isViewControlActive(this.viewMode, control);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    for (const button of this.morePanel.querySelectorAll<HTMLButtonElement>("button[data-layout]")) {
      const selected = normalizeReaderLayout(button.dataset.layout) === this.layoutMode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-checked", String(selected));
    }
  }

  private async onDocumentTab(event: Event): Promise<void> {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    const closeId = button?.dataset.closeDocument;
    const selectId = button?.dataset.documentId;
    if (closeId) await this.closeDocument(closeId);
    else if (selectId) await this.switchOpenDocument(selectId);
  }

  private async onViewControl(event: Event): Promise<void> {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-view]") : null;
    if (!button || this.animating || this.opening) return;
    const control = button.dataset.view;
    if (control === "page" && this.viewMode === "grid") await this.exitGrid(this.gridFocusPage);
    else if (control === "grid" && this.viewMode === "reading") await this.enterGridFromControl();
    this.renderChrome();
  }

  private async togglePageWidth(at: Point): Promise<void> {
    if (!this.currentLayout || this.layoutMode === "continuous") return;
    let animateToFit = false;
    if (this.fit === "width" || this.camera.scale > 1.01) {
      animateToFit = true;
      this.track.classList.add("zoom-settling");
      this.setPageFit();
    } else {
      this.focusSpreadPage(this.focusedReadingPage(at));
      const scale = pageWidthZoom(this.currentLayout, this.viewport(), this.safeInsets());
      if (!hasMeaningfulZoomDelta(this.camera.scale, scale)) return;
      this.fit = "width";
      this.camera = constrainCamera(zoomCameraAt(this.camera, scale, at), this.cameraBoundsLayout() ?? this.currentLayout, this.viewport(), this.safeInsets());
    }
    this.applyTransform();
    if (animateToFit) {
      await wait(this.reducedMotion() ? 1 : 180);
      this.track.classList.remove("zoom-settling");
    }
    await this.refreshRendering();
    this.queuePositionSave();
  }

  private async turnPage(direction: -1 | 1, releaseVelocity = 0): Promise<void> {
    if (!this.document || this.viewMode !== "reading" || !this.hasPage(direction)) return;
    const document = this.document;
    this.cancelSelection();
    this.cancelInk();
    const turnGeneration = ++this.pageTurnGeneration;
    this.clearPendingTap();
    this.setChromeVisible(false);
    this.viewGeneration += 1;
    this.renderer.cancel();
    this.animating = true;
    this.pageTurnSettling = true;
    const targetOffset = direction * -this.viewport().width;
    const settle = this.settleMotion(this.swipeOffset, targetOffset, releaseVelocity);
    this.setTransitionMotion(settle.durationMilliseconds, settle.initialControlY);
    this.track.classList.add("settling");
    this.swipeOffset = targetOffset;
    this.applyTransform();
    await wait(settle.durationMilliseconds);
    if (turnGeneration !== this.pageTurnGeneration || document !== this.document) return;
    this.page = this.layoutMode === "twoUp" || this.layoutMode === "twoUpCover"
      ? nextSpreadPage(this.page, document.pageCount, this.layoutMode, direction)
      : this.page + direction;
    this.fit = "page";
    this.camera = { x: 0, y: 0, scale: 1 };
    this.swipeOffset = 0;
    this.track.classList.remove("settling");
    this.pageTurnSettling = false;
    const knownLayout = this.layouts.get(this.page);
    if (knownLayout) this.currentLayout = knownLayout;
    const promoted = this.promoteAdjacent(direction);
    this.applyTransform();
    this.canvases.current.setAttribute("aria-label", `Page ${this.page} of ${document.pageCount}`);
    this.queuePositionSave();
    if (this.bufferedPageTouch) {
      this.singleTouch = this.bufferedPageTouch;
      this.bufferedPageTouch = undefined;
    }
    this.animating = false;
    if (promoted) {
      const refresh = this.refreshRendering(direction);
      if (this.queuedPageTurn) {
        try {
          await refresh;
          await this.executeQueuedPageTurn(document, turnGeneration);
        } catch (error) {
          this.queuedPageTurn = undefined;
          this.showStatus(`Page ${this.page} could not be rendered: ${errorMessage(error)}`, true);
        }
      } else {
        void refresh.catch((error) => {
          this.showStatus(`Page ${this.page} could not be rendered: ${errorMessage(error)}`, true);
        });
      }
      return;
    }
    try {
      await this.refreshRendering(direction);
      await this.executeQueuedPageTurn(document, turnGeneration);
    } catch (error) {
      this.queuedPageTurn = undefined;
      this.showStatus(`Page ${this.page} could not be rendered: ${errorMessage(error)}`, true);
    }
  }

  private async executeQueuedPageTurn(document: PdfDocument, turnGeneration: number): Promise<void> {
    if (turnGeneration !== this.pageTurnGeneration || document !== this.document) return;
    const queued = this.queuedPageTurn;
    this.queuedPageTurn = undefined;
    if (!queued || queued.direction === 0 || this.singleTouch || this.viewMode !== "reading" || this.layoutMode === "continuous" || !this.hasPage(queued.direction)) return;
    await this.turnPage(queued.direction, queued.releaseVelocity);
  }

  private promoteAdjacent(direction: -1 | 1): boolean {
    if ((this.layoutMode === "twoUp" || this.layoutMode === "twoUpCover") && this.document) {
      const slots = adjacentSpreadSlots(this.page, this.document.pageCount, this.layoutMode);
      const current = slots.find((slot) => slot.slot === 0);
      if (!current || current.pages.some((page) => this.spreadCanvases.get(page)?.hidden !== false)) return false;
      const slotByPage = new Map(slots.flatMap((slot) => slot.pages.map((page) => [page, slot.slot] as const)));
      for (const [page, canvas] of this.spreadCanvases) {
        const slot = slotByPage.get(page);
        const layout = this.layouts.get(page);
        if (slot === undefined || !layout) {
          canvas.hidden = true;
          continue;
        }
        this.positionCanvas(canvas, layout, slot * this.viewport().width);
        canvas.hidden = false;
      }
      this.currentLayout = this.layouts.get(this.page) ?? this.layouts.get(current.anchorPage);
      return this.currentLayout !== undefined;
    }
    if (this.layoutMode !== "single") return false;
    const source = direction > 0 ? this.canvases.next : this.canvases.previous;
    if (source.hidden || !this.currentLayout) return false;
    if (direction > 0) {
      this.canvases = {
        previous: this.canvases.current,
        current: this.canvases.next,
        next: this.canvases.previous
      };
    } else {
      this.canvases = {
        previous: this.canvases.next,
        current: this.canvases.previous,
        next: this.canvases.current
      };
    }
    this.canvases.current.hidden = false;
    this.canvases.current.removeAttribute("aria-hidden");
    for (const adjacent of [this.canvases.previous, this.canvases.next]) {
      adjacent.setAttribute("aria-hidden", "true");
      adjacent.removeAttribute("aria-label");
    }
    this.positionCanvas(this.canvases.current, this.currentLayout, 0);
    this.positionKnownAdjacent(this.canvases.previous, this.page - 1, -this.viewport().width);
    this.positionKnownAdjacent(this.canvases.next, this.page + 1, this.viewport().width);
    return true;
  }

  private positionKnownAdjacent(canvas: HTMLCanvasElement, page: number, offset: number): void {
    const layout = this.layouts.get(page);
    if (!layout) {
      canvas.hidden = true;
      return;
    }
    this.positionCanvas(canvas, layout, offset);
  }

  private async settleSwipeBack(releaseVelocity = 0): Promise<void> {
    const settle = this.settleMotion(this.swipeOffset, 0, releaseVelocity);
    this.setTransitionMotion(settle.durationMilliseconds, settle.initialControlY);
    this.track.classList.add("settling");
    this.swipeOffset = 0;
    this.applyTransform();
    await wait(settle.durationMilliseconds);
    this.track.classList.remove("settling");
  }

  private cancelTouches(): void {
    this.pageTurnGeneration += 1;
    this.cancelGridMomentum();
    this.cancelContinuousMomentum();
    this.singleTouch = undefined;
    this.bufferedPageTouch = undefined;
    this.queuedPageTurn = undefined;
    this.pinchTouch = undefined;
    this.swipeOffset = 0;
    this.gridGesture = undefined;
    this.semanticZoom = this.viewMode === "grid" ? GRID_REST_SCALE : 1;
    this.track.classList.remove("settling");
    if (this.pageTurnSettling) this.animating = false;
    this.pageTurnSettling = false;
    this.applyTransform();
    this.cancelLongPress();
  }

  private penInputActive(): boolean {
    return this.penPointers.size > 0 || performance.now() < this.suppressTouchesUntil;
  }

  private async refreshRendering(preferredDirection: -1 | 0 | 1 = 0): Promise<void> {
    const document = this.document;
    if (!document) return;
    if (this.layoutMode === "continuous") {
      await this.refreshContinuousRendering();
      return;
    }
    if (this.layoutMode === "twoUp" || this.layoutMode === "twoUpCover") {
      await this.refreshSpreadRendering(preferredDirection);
      return;
    }
    this.clearLayoutCanvases(true);
    const generation = ++this.viewGeneration;
    const page = this.page;
    const canvases = { ...this.canvases };
    const pages = [page, page - 1, page + 1].filter((candidate) => candidate >= 1 && candidate <= document.pageCount);
    const layouts = await Promise.all(pages.map(async (page) => [page, await this.layoutFor(page)] as const));
    if (generation !== this.viewGeneration
      || document !== this.document
      || page !== this.page
      || this.layoutMode !== "single"
      || canvases.previous !== this.canvases.previous
      || canvases.current !== this.canvases.current
      || canvases.next !== this.canvases.next) return;
    this.layouts.clear();
    for (const [pageNumber, layout] of layouts) this.layouts.set(pageNumber, layout);
    const current = this.layouts.get(page);
    if (!current) throw new Error("Current page layout is unavailable.");
    this.currentLayout = current;
    const specs: PageRenderSpec[] = [];
    this.addRenderSpec(specs, page, canvases.current, 0, 0, this.camera.scale);
    this.addRenderSpec(specs, page - 1, canvases.previous, -this.viewport().width, preferredDirection < 0 ? 1 : 2, 1);
    this.addRenderSpec(specs, page + 1, canvases.next, this.viewport().width, preferredDirection > 0 ? 1 : 2, 1);
    await this.renderer.settle(document, specs);
    if (generation === this.viewGeneration && document === this.document && page === this.page) void this.refreshHitOverlays();
  }

  private async refreshSpreadRendering(preferredDirection: -1 | 0 | 1 = 0): Promise<void> {
    const document = this.document;
    if (!document || (this.layoutMode !== "twoUp" && this.layoutMode !== "twoUpCover")) return;
    const generation = ++this.viewGeneration;
    const slots = adjacentSpreadSlots(this.page, document.pageCount, this.layoutMode);
    const prepared = await Promise.all(slots.map(async (slot) => ({
      slot,
      spread: layoutSpread(
        await Promise.all(slot.pages.map(async (pageNumber) => ({ pageNumber, size: await document.pageSize(pageNumber) }))),
        this.viewport(),
        this.safeInsets()
      )
    })));
    if (generation !== this.viewGeneration || document !== this.document) return;
    this.layouts.clear();
    for (const { spread } of prepared) {
      for (const layout of spread.pages) this.layouts.set(layout.pageNumber, layout);
    }
    this.currentLayout = this.layouts.get(this.page) ?? prepared.find(({ slot }) => slot.slot === 0)?.spread.pages[0];
    if (!this.currentLayout) return;
    this.canvases.previous.hidden = true;
    this.canvases.current.hidden = true;
    this.canvases.next.hidden = true;
    const visible = new Set(slots.flatMap((slot) => slot.pages));
    const specs: PageRenderSpec[] = [];
    for (const { slot, spread } of prepared) {
      for (const layout of spread.pages) {
        const pageNumber = layout.pageNumber;
        let canvas = this.spreadCanvases.get(pageNumber);
        if (!canvas) {
          canvas = documentElement("canvas", "pdf-page spread-page");
          this.track.insertBefore(canvas, this.pageAnnotationLayer);
          this.spreadCanvases.set(pageNumber, canvas);
        }
        this.positionCanvas(canvas, layout, slot.slot * this.viewport().width);
        canvas.setAttribute("aria-label", `Page ${pageNumber} of ${document.pageCount}`);
        const dpr = Math.min(Math.max(window.devicePixelRatio, 1), 2.5);
        const rasterScale = slot.slot === 0 ? this.camera.scale : 1;
        const rasterMultiplier = boundedRasterMultiplier(layout.width, layout.height, rasterScale, dpr);
        const directionalPriority = slot.slot === 0 ? 0 : slot.slot === preferredDirection ? 2 : 3;
        specs.push({
          pageNumber,
          canvas,
          cssWidth: layout.width,
          cssHeight: layout.height,
          pdfScale: layout.scale * rasterScale * rasterMultiplier,
          dpr,
          priority: directionalPriority + (pageNumber === this.page ? 0 : 1)
        });
      }
    }
    for (const [pageNumber, canvas] of this.spreadCanvases) {
      if (visible.has(pageNumber)) continue;
      canvas.remove();
      this.spreadCanvases.delete(pageNumber);
    }
    this.camera = constrainCamera(this.camera, this.cameraBoundsLayout() ?? this.currentLayout, this.viewport(), this.safeInsets());
    this.applyTransform();
    await this.renderer.settle(document, specs);
    void this.refreshHitOverlays();
  }

  private async refreshContinuousRendering(): Promise<void> {
    const document = this.document;
    if (!document) return;
    if (!this.continuousLayout) this.rebuildContinuousLayout();
    const layout = this.continuousLayout;
    if (!layout) return;
    const pages = visibleContinuousPages(layout, this.continuousScroll, this.viewport(), 1);
    const visible = new Set(pages.map((page) => page.pageNumber));
    for (const [pageNumber, canvas] of this.continuousCanvases) {
      if (visible.has(pageNumber)) continue;
      canvas.remove();
      this.continuousCanvases.delete(pageNumber);
    }
    const specs: PageRenderSpec[] = [];
    for (const pageLayout of pages) {
      let canvas = this.continuousCanvases.get(pageLayout.pageNumber);
      if (!canvas) {
        canvas = documentElement("canvas", "pdf-page continuous-page");
        this.continuousLayer.insertBefore(canvas, this.continuousAnnotationLayer);
        this.continuousCanvases.set(pageLayout.pageNumber, canvas);
      }
      canvas.style.left = `${pageLayout.x}px`;
      canvas.style.top = `${pageLayout.y}px`;
      canvas.setAttribute("aria-label", `Page ${pageLayout.pageNumber} of ${document.pageCount}`);
      const dpr = Math.min(Math.max(window.devicePixelRatio, 1), 2);
      specs.push({
        pageNumber: pageLayout.pageNumber,
        canvas,
        cssWidth: pageLayout.width,
        cssHeight: pageLayout.height,
        pdfScale: pageLayout.scale,
        dpr,
        priority: Math.abs(pageLayout.pageNumber - this.page)
      });
    }
    this.syncContinuousFocus();
    this.continuousSyncedScroll = this.continuousScroll;
    await this.renderer.settle(document, specs);
    void this.refreshHitOverlays();
  }

  private addRenderSpec(
    specs: PageRenderSpec[],
    page: number,
    canvas: HTMLCanvasElement,
    slotOffset: number,
    priority: number,
    rasterScale: number
  ): void {
    const layout = this.layouts.get(page);
    if (!layout) {
      canvas.hidden = true;
      return;
    }
    this.positionCanvas(canvas, layout, slotOffset);
    const dpr = Math.min(Math.max(window.devicePixelRatio, 1), 2.5);
    const rasterMultiplier = boundedRasterMultiplier(layout.width, layout.height, rasterScale, dpr);
    specs.push({
      pageNumber: page,
      canvas,
      cssWidth: layout.width,
      cssHeight: layout.height,
      pdfScale: layout.scale * rasterScale * rasterMultiplier,
      dpr,
      priority
    });
  }

  private positionCanvas(canvas: HTMLCanvasElement, layout: PageLayout, slotOffset: number): void {
    canvas.style.left = `${layout.x + slotOffset}px`;
    canvas.style.top = `${layout.y}px`;
  }

  private async layoutFor(page: number): Promise<PageLayout> {
    const document = this.document;
    if (!document) throw new Error("No PDF is open.");
    return layoutSinglePage(await document.pageSize(page), this.viewport(), this.safeInsets());
  }

  private applyTransform(): void {
    this.track.style.transform = `translate3d(${this.camera.x + this.swipeOffset}px, ${this.camera.y}px, 0) scale(${this.camera.scale})`;
    this.continuousLayer.style.transform = `translate3d(0, ${-this.continuousScroll}px, 0)`;
    const gridCamera = this.gridGesture ?? { x: this.gridOffset + this.gridBounce, y: 0, scale: 1 };
    this.gridLayer.style.transform = `translate3d(${gridCamera.x}px, ${gridCamera.y}px, 0) scale(${gridCamera.scale})`;
    const interacting = this.pinchTouch !== undefined;
    this.track.style.opacity = `${interacting ? readingLayerOpacity(this.semanticZoom) : this.viewMode === "reading" ? 1 : 0}`;
    this.gridLayer.style.opacity = `${interacting ? gridLayerOpacity(this.semanticZoom) : this.viewMode === "grid" ? 1 : 0}`;
    const continuousShown = this.viewMode === "reading" && this.layoutMode === "continuous";
    this.continuousLayer.hidden = !continuousShown;
    this.track.hidden = continuousShown;
    this.scene.dataset.view = this.viewMode;
  }

  private settleMotion(from: number, to: number, releaseVelocity: number): { durationMilliseconds: number; initialControlY: number } {
    return this.reducedMotion()
      ? { durationMilliseconds: 1, initialControlY: 0.28 }
      : pageSettleMotion(from, to, releaseVelocity);
  }

  private setTransitionMotion(milliseconds: number, initialControlY: number): void {
    this.track.style.setProperty("--page-settle-ms", `${milliseconds}ms`);
    this.track.style.setProperty("--page-settle-easing", `cubic-bezier(0.28, ${initialControlY}, 0.58, 1)`);
  }

  private setPageFit(): void {
    if (!this.currentLayout) return;
    this.fit = "page";
    this.camera = constrainCamera({ x: 0, y: 0, scale: 1 }, this.cameraBoundsLayout() ?? this.currentLayout, this.viewport(), this.safeInsets());
  }

  private hasPage(direction: -1 | 1): boolean {
    if (!this.document) return false;
    if (this.layoutMode === "twoUp" || this.layoutMode === "twoUpCover") {
      const current = spreadPageNumbers(this.page, this.document.pageCount, this.layoutMode)[0];
      return nextSpreadPage(this.page, this.document.pageCount, this.layoutMode, direction) !== current;
    }
    return this.page + direction >= 1 && this.page + direction <= this.document.pageCount;
  }

  private viewport(): Size {
    return { width: Math.max(1, this.scene.clientWidth), height: Math.max(1, this.scene.clientHeight) };
  }

  private safeInsets(): Insets {
    const measure = required<HTMLElement>(this.root, "#safe-area-measure");
    const style = getComputedStyle(measure);
    return {
      top: pixelValue(style.paddingTop),
      right: pixelValue(style.paddingRight),
      bottom: pixelValue(style.paddingBottom),
      left: pixelValue(style.paddingLeft)
    };
  }

  private readingPosition(): ReadingPosition {
    if (!this.currentLayout) return defaultReadingPosition();
    const center = normalizedPageCenter(this.camera, this.currentLayout, this.viewport());
    const position: ReadingPosition = {
      version: 1,
      page: this.page,
      fit: this.fit,
      scale: this.camera.scale,
      centerX: center.x,
      centerY: center.y
    };
    if (this.layoutMode !== "single") position.layout = this.layoutMode;
    return position;
  }

  private cameraFromPosition(position: ReadingPosition, layout: PageLayout): Camera {
    const viewport = this.viewport();
    const insets = this.safeInsets();
    const scale = position.fit === "page"
      ? 1
      : position.fit === "width"
        ? pageWidthZoom(layout, viewport, insets)
        : position.scale;
    const pagePoint = {
      x: layout.x + layout.width * position.centerX,
      y: layout.y + layout.height * position.centerY
    };
    return constrainCamera(
      cameraForPagePoint(pagePoint, { x: viewport.width / 2, y: viewport.height / 2 }, scale),
      layout,
      viewport,
      insets
    );
  }

  private queuePositionSave(): void {
    if (this.persistenceTimer !== undefined) window.clearTimeout(this.persistenceTimer);
    this.persistenceTimer = window.setTimeout(() => {
      this.persistenceTimer = undefined;
      void this.flushPosition();
    }, 500);
  }

  private async flushPosition(): Promise<void> {
    if (this.persistenceTimer !== undefined) {
      window.clearTimeout(this.persistenceTimer);
      this.persistenceTimer = undefined;
    }
    const sidecar = this.sidecar;
    if (!sidecar) return;
    const position = this.readingPosition();
    sidecar.position = position;
    try {
      await updateReadingPosition(sidecar.id, position);
    } catch (error) {
      console.error("Unable to persist reading position", error);
    }
  }

  private queueResize(): void {
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = undefined;
      void this.resize().catch((error) => this.showStatus(`Layout failed: ${errorMessage(error)}`, true));
    });
  }

  private async resize(): Promise<void> {
    if (!this.document || !this.currentLayout) return;
    this.cancelSelection();
    this.cancelInk();
    this.cancelGridMomentum();
    this.cancelContinuousMomentum();
    const position = this.readingPosition();
    this.layouts.clear();
    const layout = await this.layoutFor(this.page);
    this.currentLayout = layout;
    this.camera = this.cameraFromPosition(position, layout);
    if (this.layoutMode === "continuous") {
      this.rebuildContinuousLayout();
      if (this.continuousLayout) this.continuousScroll = continuousScrollForPage(this.continuousLayout, position.page, this.viewport());
    }
    if (this.gridLayout) {
      this.rebuildGridLayout();
      if (this.gridLayout) this.gridOffset = gridOffsetForPage(this.gridLayout, this.gridFocusPage, this.viewport(), this.safeInsets());
    }
    this.applyTransform();
    await this.refreshRendering();
    if (this.viewMode === "grid") this.syncGridThumbnails();
  }

  private async onKeyDown(event: KeyboardEvent): Promise<void> {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.openFind();
      return;
    }
    if (event.key === "Escape") {
      if (!this.findPanel.hidden || !this.morePanel.hidden || !this.drawerPanel.hidden || !this.annotationEditor.hidden) {
        event.preventDefault();
        this.closePanels();
      } else if (this.chromeVisible) {
        event.preventDefault();
        this.setChromeVisible(false);
      }
      return;
    }
    const typing = isTypingTarget(event.target) || isTypingTarget(document.activeElement);
    if (suppressReaderShortcutWhileTyping({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, typing })) return;
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.openFind();
    } else if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    } else if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      this.fileInput.click();
    } else if (event.key === "0" && this.currentLayout) {
      event.preventDefault();
      this.cancelContinuousMomentum();
      if (this.viewMode === "grid") await this.exitGrid(this.gridFocusPage);
      else {
        this.setPageFit();
        this.applyTransform();
        await this.refreshRendering();
        this.queuePositionSave();
      }
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && this.viewMode === "reading" && this.layoutMode !== "continuous" && this.camera.scale <= 1.01) {
      event.preventDefault();
      await this.turnPage(event.key === "ArrowRight" ? 1 : -1);
    }
  }

  private openFind(): void {
    if (!this.document) return;
    this.closePanels();
    this.setChromeVisible(false);
    this.findPanel.hidden = false;
    this.panelBackdrop.hidden = false;
    this.findInput.focus();
    this.findInput.select();
  }

  private openMore(): void {
    if (!this.document) return;
    this.closePanels();
    this.setChromeVisible(false);
    this.morePanel.hidden = false;
    this.panelBackdrop.hidden = false;
    this.renderChrome();
    this.morePanel.querySelector<HTMLButtonElement>("button[data-layout]")?.focus();
  }

  private closePanels(): void {
    this.cancelPanelMomentum();
    this.cancelContinuousMomentum();
    this.panelScrollTouch = undefined;
    if (!this.findPanel.hidden) {
      this.searchGenerations.cancel();
      if (this.searchInputTimer !== undefined) window.clearTimeout(this.searchInputTimer);
      this.searchInputTimer = undefined;
    }
    this.findPanel.hidden = true;
    this.morePanel.hidden = true;
    this.drawerPanel.hidden = true;
    this.annotationEditor.hidden = true;
    this.editingNoteId = undefined;
    this.panelBackdrop.hidden = true;
    if (this.selection) this.selectionActions.hidden = false;
  }

  private async onMoreAction(event: Event): Promise<void> {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    const requestedLayout = button?.dataset.layout;
    if (requestedLayout) {
      await this.switchLayout(normalizeReaderLayout(requestedLayout));
    } else if (button?.id === "outline-open") {
      await this.openOutline();
    } else if (button?.id === "recents-open") {
      this.openRecents();
    } else if (button?.id === "annotations-open") {
      this.openAnnotations();
    }
  }

  private async switchLayout(layout: ReaderLayout): Promise<void> {
    if (!this.document || layout === this.layoutMode) {
      this.closePanels();
      return;
    }
    if (this.viewMode === "grid") await this.exitGrid(this.gridFocusPage);
    this.cancelSelection();
    this.cancelInk();
    this.cancelTouches();
    this.renderer.cancel();
    this.clearLayoutCanvases();
    this.layoutMode = layout;
    this.fit = "page";
    this.camera = { x: 0, y: 0, scale: 1 };
    if (layout !== "single") await this.prepareGrid();
    this.currentLayout = await this.layoutFor(this.page);
    if (layout === "continuous") {
      this.rebuildContinuousLayout();
      if (this.continuousLayout) this.continuousScroll = continuousScrollForPage(this.continuousLayout, this.page, this.viewport());
    }
    this.setPageFit();
    this.applyTransform();
    await this.refreshRendering();
    this.closePanels();
    this.queuePositionSave();
    this.renderChrome();
  }

  private async runSearch(): Promise<void> {
    const document = this.document;
    const query = this.findInput.value.trim();
    if (this.searchInputTimer !== undefined) window.clearTimeout(this.searchInputTimer);
    this.searchInputTimer = undefined;
    this.searchGenerations.cancel();
    this.searchHits = [];
    this.activeSearchHit = -1;
    this.pageHitLayer.replaceChildren();
    this.continuousHitLayer.replaceChildren();
    if (!document || !query) {
      this.findSummary.textContent = "Enter text to search.";
      this.findResults.replaceChildren();
      return;
    }
    this.findSummary.textContent = `Scanning 0 of ${document.pageCount}…`;
    this.findResults.replaceChildren();
    try {
      const result = await searchPages(
        document.pageCount,
        query,
        (pageNumber) => document.pageText(pageNumber),
        this.searchGenerations,
        (progress) => {
          if (document !== this.document) return;
          this.findSummary.textContent = `Scanning ${progress.scanned} of ${progress.total} · ${progress.matchCount} matches`;
        }
      );
      if (result.cancelled || document !== this.document) return;
      this.searchHits = result.hits;
      this.activeSearchHit = result.hits.length > 0 ? 0 : -1;
      this.renderSearchResults();
      this.findSummary.textContent = result.textPages === 0
        ? `Scanned ${result.total} pages · no searchable text`
        : `${result.matchCount} matches · ${result.total} pages scanned`;
      if (this.activeSearchHit >= 0) await this.goToSearchHit(this.activeSearchHit);
    } catch (error) {
      this.findSummary.textContent = `Search failed: ${errorMessage(error)}`;
    }
  }

  private renderSearchResults(): void {
    this.findResults.replaceChildren();
    this.searchHits.forEach((hit, index) => {
      const item = documentElement("li", "find-result");
      const button = documentElement("button", "find-result-button");
      button.type = "button";
      button.dataset.searchIndex = String(index);
      button.setAttribute("aria-current", String(index === this.activeSearchHit));
      const page = documentElement("strong", "find-result-page");
      page.textContent = `Page ${hit.pageNumber}`;
      const context = documentElement("span", "find-result-context");
      context.textContent = hit.context;
      button.append(page, context);
      item.append(button);
      this.findResults.append(item);
    });
  }

  private async moveSearchHit(direction: -1 | 1): Promise<void> {
    if (this.searchHits.length === 0) return;
    const current = this.activeSearchHit < 0 ? 0 : this.activeSearchHit;
    this.activeSearchHit = (current + direction + this.searchHits.length) % this.searchHits.length;
    this.renderSearchResults();
    await this.goToSearchHit(this.activeSearchHit);
  }

  private async selectSearchResult(event: Event): Promise<void> {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-search-index]") : null;
    const index = Number(button?.dataset.searchIndex);
    if (!Number.isInteger(index) || index < 0 || index >= this.searchHits.length) return;
    this.activeSearchHit = index;
    this.renderSearchResults();
    await this.goToSearchHit(index);
  }

  private async goToSearchHit(index: number): Promise<void> {
    const hit = this.searchHits[index];
    if (!hit) return;
    await this.goToPage(hit.pageNumber);
    await this.refreshHitOverlays();
  }

  private async goToPage(pageNumber: number): Promise<void> {
    const document = this.document;
    if (!document) return;
    this.cancelSelection();
    this.cancelInk();
    const bounded = Math.min(document.pageCount, Math.max(1, Math.round(pageNumber)));
    if (this.viewMode === "grid") await this.exitGrid(bounded);
    this.page = bounded;
    this.gridFocusPage = bounded;
    this.fit = "page";
    this.camera = { x: 0, y: 0, scale: 1 };
    if (this.layoutMode === "continuous") {
      this.rebuildContinuousLayout();
      if (this.continuousLayout) this.continuousScroll = continuousScrollForPage(this.continuousLayout, bounded, this.viewport());
    }
    this.currentLayout = await this.layoutFor(bounded);
    this.setPageFit();
    this.applyTransform();
    await this.refreshRendering();
    this.queuePositionSave();
  }

  private async refreshHitOverlays(): Promise<void> {
    const document = this.document;
    const generation = ++this.hitOverlayGeneration;
    this.pageHitLayer.replaceChildren();
    this.continuousHitLayer.replaceChildren();
    this.refreshAnnotationOverlays();
    if (!document || this.searchHits.length === 0) return;
    const targets: { pageNumber: number; layout: PageLayout; layer: HTMLElement }[] = [];
    if (this.layoutMode === "continuous" && this.continuousLayout) {
      for (const layout of visibleContinuousPages(this.continuousLayout, this.continuousScroll, this.viewport(), 1)) {
        targets.push({ pageNumber: layout.pageNumber, layout, layer: this.continuousHitLayer });
      }
    } else if ((this.layoutMode === "twoUp" || this.layoutMode === "twoUpCover") && this.document) {
      for (const pageNumber of spreadPageNumbers(this.page, this.document.pageCount, this.layoutMode)) {
        const layout = this.layouts.get(pageNumber);
        if (layout) targets.push({ pageNumber, layout, layer: this.pageHitLayer });
      }
    } else if (this.currentLayout) {
      targets.push({ pageNumber: this.page, layout: this.currentLayout, layer: this.pageHitLayer });
    }
    const visibleTargets = targets.filter((target) => this.searchHits.some((hit) => hit.pageNumber === target.pageNumber));
    const texts = await Promise.all(visibleTargets.map(async (target) => ({ target, text: await document.pageText(target.pageNumber) })));
    if (generation !== this.hitOverlayGeneration || document !== this.document) return;
    for (const { target, text } of texts) {
      const pageHits = this.searchHits.map((hit, index) => ({ hit, index })).filter(({ hit }) => hit.pageNumber === target.pageNumber);
      for (const { hit, index } of pageHits) {
        for (const segment of hit.segments) {
          const item = text.items[segment.itemIndex];
          if (!item) continue;
          const normalizedLength = Math.max(1, normalizeSearchText(item.text).length);
          const startFraction = segment.startOffset / normalizedLength;
          const widthFraction = Math.max(0, segment.endOffset - segment.startOffset) / normalizedLength;
          const marker = documentElement("div", "search-hit");
          marker.classList.toggle("current", index === this.activeSearchHit);
          marker.style.left = `${target.layout.x + (item.x + item.width * startFraction) * target.layout.width / Math.max(1, text.width)}px`;
          marker.style.top = `${target.layout.y + item.y * target.layout.height / Math.max(1, text.height)}px`;
          marker.style.width = `${Math.max(2, item.width * widthFraction * target.layout.width / Math.max(1, text.width))}px`;
          marker.style.height = `${Math.max(2, item.height * target.layout.height / Math.max(1, text.height))}px`;
          target.layer.append(marker);
        }
      }
    }
  }

  private clearSearch(): void {
    this.searchGenerations.cancel();
    this.hitOverlayGeneration += 1;
    if (this.searchInputTimer !== undefined) window.clearTimeout(this.searchInputTimer);
    this.searchInputTimer = undefined;
    this.searchHits = [];
    this.activeSearchHit = -1;
    this.pageHitLayer.replaceChildren();
    this.continuousHitLayer.replaceChildren();
    this.findResults.replaceChildren();
    this.findSummary.textContent = "Enter text to search.";
  }

  private scheduleLongPress(touch: SingleTouch, point: Point): void {
    this.cancelLongPress();
    if (this.viewMode !== "reading" || !this.document || this.animating) return;
    const generation = ++this.longPressGeneration;
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = undefined;
      void this.beginTextSelection(touch, point, generation);
    }, 480);
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== undefined) window.clearTimeout(this.longPressTimer);
    this.longPressTimer = undefined;
    this.longPressGeneration += 1;
  }

  private async beginTextSelection(touch: SingleTouch, point: Point, generation: number): Promise<void> {
    const document = this.document;
    const hit = this.pageHitAt(point);
    if (!document || !hit || this.singleTouch !== touch || generation !== this.longPressGeneration) return;
    try {
      const pageText = await document.pageText(hit.pageNumber);
      if (document !== this.document || this.singleTouch !== touch || generation !== this.longPressGeneration) return;
      const position = characterHitTest(pageText, hit.normalized);
      const item = position ? pageText.items[position.itemIndex] : undefined;
      if (!position || !item) {
        this.showStatus("No selectable text here.", false, 1600);
        return;
      }
      const end = { itemIndex: position.itemIndex, offset: Math.min(item.text.length, position.offset + 1) };
      const geometry = selectionRangeGeometry(pageText, position, end);
      if (!geometry) {
        this.showStatus("No selectable text here.", false, 1600);
        return;
      }
      this.singleTouch = undefined;
      this.selection = {
        pageNumber: hit.pageNumber,
        pageText,
        anchorStart: position,
        anchorEnd: end,
        start: geometry.range.start,
        end: geometry.range.end,
        geometry
      };
      this.selectionTouch = { mode: "extend", pageNumber: hit.pageNumber };
      this.pendingSelectionDismissal = undefined;
      this.clearPendingTap();
      this.refreshAnnotationOverlays();
    } catch (error) {
      if (document === this.document) this.showStatus(`Text selection unavailable: ${errorMessage(error)}`, true, 2200);
    }
  }

  private onSelectionHandleStart(event: TouchEvent): void {
    const handle = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-selection-handle]") : null;
    const mode = handle?.dataset.selectionHandle;
    if (!this.selection || event.touches.length !== 1 || mode !== "start" && mode !== "end") return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelLongPress();
    this.selectionTouch = { mode, pageNumber: this.selection.pageNumber };
  }

  private async updateSelectionAt(point: Point, mode: SelectionTouch["mode"]): Promise<void> {
    const selection = this.selection;
    if (!selection) return;
    const normalized = this.normalizedAtPage(point, selection.pageNumber);
    if (!normalized) return;
    const position = characterHitTest(selection.pageText, normalized, 0.08);
    const item = position ? selection.pageText.items[position.itemIndex] : undefined;
    if (!position || !item) return;
    const afterCharacter = { itemIndex: position.itemIndex, offset: Math.min(item.text.length, position.offset + 1) };
    const extendingBackward = position.itemIndex < selection.anchorStart.itemIndex
      || position.itemIndex === selection.anchorStart.itemIndex && position.offset < selection.anchorStart.offset;
    const first = mode === "start"
      ? position
      : mode === "extend"
        ? extendingBackward ? position : selection.anchorStart
        : selection.start;
    const second = mode === "end"
      ? afterCharacter
      : mode === "extend"
        ? extendingBackward ? selection.anchorEnd : afterCharacter
        : selection.end;
    const geometry = selectionRangeGeometry(selection.pageText, first, second);
    if (!geometry) return;
    this.selection = { ...selection, start: geometry.range.start, end: geometry.range.end, geometry };
    this.refreshAnnotationOverlays();
  }

  private cancelSelection(): void {
    this.pendingSelectionDismissal = undefined;
    this.selection = undefined;
    this.selectionTouch = undefined;
    this.selectionActions.hidden = true;
    this.refreshAnnotationOverlays();
  }

  /**
   * A gesture that begins away from the selection dismisses it. A tap clears the
   * selection and is consumed so it does not also toggle chrome or navigate, and
   * a drag clears it the moment the drag is recognized so the overlay never
   * floats over a moving page. Returns whether a dismissal happened.
   */
  private applyPendingSelectionDismissal(): boolean {
    const pending = this.pendingSelectionDismissal;
    this.pendingSelectionDismissal = undefined;
    if (!pending || this.selection !== pending) return false;
    this.cancelSelection();
    return true;
  }

  private cancelAnnotationInteraction(): void {
    this.cancelLongPress();
    this.cancelSelection();
    this.cancelInk();
    this.closeNoteEditor(false);
  }

  private async copySelection(): Promise<void> {
    const text = this.selection?.geometry.text.trim();
    if (!text) return;
    const copied = await writeClipboardText(text);
    if (!copied) {
      this.showStatus("Copying text is unavailable here.", true, 2000);
      return;
    }
    this.showStatus("Copied selected text.", false, 1400);
    this.cancelSelection();
  }

  private async createHighlight(): Promise<void> {
    const selection = this.selection;
    const sidecar = this.sidecar;
    if (!selection || !sidecar) return;
    const value = normalizeAnnotation({
      ...annotationMetadata(sidecar.id, selection.pageNumber),
      kind: "highlight",
      color: DEFAULT_HIGHLIGHT_COLOR,
      rects: selection.geometry.rects,
      text: selection.geometry.text,
      context: selection.geometry.context
    });
    if (value?.kind !== "highlight") return;
    await this.persistAnnotation(value);
    this.cancelSelection();
  }

  private async persistAnnotation(annotation: Annotation): Promise<void> {
    const sidecar = this.sidecar;
    if (!sidecar || annotation.documentId !== sidecar.id) return;
    try {
      const stored = await putAnnotation(annotation);
      if (sidecar !== this.sidecar) return;
      this.annotations = orderAnnotations([...this.annotations.filter(({ id }) => id !== stored.id), stored]);
      this.refreshAnnotationOverlays();
    } catch (error) {
      this.showStatus(`Unable to save annotation: ${errorMessage(error)}`, true);
    }
  }

  private openNoteEditor(annotation?: NoteAnnotation): void {
    if (!annotation && !this.selection) return;
    this.closePanels();
    this.editingNoteId = annotation?.id;
    this.annotationText.value = annotation?.body ?? "";
    this.annotationEditor.hidden = false;
    this.panelBackdrop.hidden = false;
    this.selectionActions.hidden = true;
    this.annotationText.focus();
  }

  private closeNoteEditor(restoreSelection = true): void {
    this.annotationEditor.hidden = true;
    this.editingNoteId = undefined;
    this.annotationText.value = "";
    if (this.findPanel.hidden && this.morePanel.hidden && this.drawerPanel.hidden) this.panelBackdrop.hidden = true;
    if (restoreSelection && this.selection) this.selectionActions.hidden = false;
  }

  private async saveNote(): Promise<void> {
    const body = this.annotationText.value.trim();
    const existing = this.annotations.find((annotation): annotation is NoteAnnotation => annotation.id === this.editingNoteId && annotation.kind === "note");
    let note: NoteAnnotation | undefined;
    if (existing) {
      note = normalizeAnnotation({ ...existing, body, updatedAt: Date.now() }) as NoteAnnotation | undefined;
    } else if (this.selection && this.sidecar) {
      note = normalizeAnnotation({
        ...annotationMetadata(this.sidecar.id, this.selection.pageNumber),
        kind: "note",
        color: DEFAULT_NOTE_COLOR,
        rects: this.selection.geometry.rects,
        text: this.selection.geometry.text,
        context: this.selection.geometry.context,
        body
      }) as NoteAnnotation | undefined;
    }
    if (!note || note.kind !== "note") return;
    await this.persistAnnotation(note);
    this.closeNoteEditor(false);
    this.cancelSelection();
  }

  private onAnnotationLayerAction(event: Event): void {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-note-id]") : null;
    const annotation = this.annotations.find((value): value is NoteAnnotation => value.id === button?.dataset.noteId && value.kind === "note");
    if (annotation) this.openNoteEditor(annotation);
  }

  private openAnnotations(): void {
    this.closePanels();
    this.drawerPanel.hidden = false;
    this.panelBackdrop.hidden = false;
    this.drawerTitle.textContent = "Annotations";
    this.drawerContent.replaceChildren();
    required<HTMLButtonElement>(this.root, "#drawer-close").focus();
    if (this.annotations.length === 0) {
      this.drawerContent.textContent = "No annotations in this PDF.";
      return;
    }
    const list = documentElement("ol", "annotations-list");
    for (const annotation of orderAnnotations(this.annotations)) {
      const row = documentElement("li", "annotation-list-item");
      const select = documentElement("button", "annotation-list-select");
      select.type = "button";
      select.dataset.annotationId = annotation.id;
      const title = documentElement("strong", "annotation-list-title");
      title.textContent = `Page ${annotation.pageNumber} · ${annotation.kind === "ink" ? "Ink" : annotation.kind === "note" ? "Note" : "Highlight"}`;
      const snippet = documentElement("span", "annotation-list-snippet");
      snippet.textContent = annotation.kind === "ink"
        ? `${annotation.points.length} stroke points`
        : annotation.kind === "note" && annotation.body ? annotation.body : annotation.text || annotation.context || "Selected text";
      const time = documentElement("time", "annotation-list-time");
      time.dateTime = new Date(annotation.createdAt).toISOString();
      time.textContent = new Date(annotation.createdAt).toLocaleString();
      select.append(title, snippet, time);
      const remove = documentElement("button", "annotation-delete");
      remove.type = "button";
      remove.dataset.deleteAnnotation = annotation.id;
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete ${annotation.kind} on page ${annotation.pageNumber}`);
      row.append(select, remove);
      list.append(row);
    }
    this.drawerContent.append(list);
  }

  private refreshAnnotationOverlays(): void {
    const generation = ++this.annotationOverlayGeneration;
    this.removeLiveInkSurface();
    this.pageAnnotationLayer.replaceChildren();
    this.continuousAnnotationLayer.replaceChildren();
    this.selectionActions.hidden = !this.selection || !this.annotationEditor.hidden;
    if (!this.document || this.viewMode !== "reading") return;
    const targets = this.visibleOverlayTargets();
    if (generation !== this.annotationOverlayGeneration) return;
    for (const target of targets) {
      for (const annotation of annotationsForPage(this.annotations, target.pageNumber)) {
        this.renderAnnotation(annotation, target.layout, target.layer);
      }
      if (this.ink?.pageNumber === target.pageNumber && this.ink.documentId === this.sidecar?.id) {
        this.mountLiveInkSurface(this.ink, target.layout, target.layer);
      }
      if (this.selection?.pageNumber === target.pageNumber) this.renderSelection(this.selection, target.layout, target.layer);
    }
  }

  private visibleOverlayTargets(): { pageNumber: number; layout: PageLayout; layer: HTMLElement }[] {
    if (this.layoutMode === "continuous" && this.continuousLayout) {
      return visibleContinuousPages(this.continuousLayout, this.continuousScroll, this.viewport(), 1)
        .map((layout) => ({ pageNumber: layout.pageNumber, layout, layer: this.continuousAnnotationLayer }));
    }
    if ((this.layoutMode === "twoUp" || this.layoutMode === "twoUpCover") && this.document) {
      return spreadPageNumbers(this.page, this.document.pageCount, this.layoutMode).flatMap((pageNumber) => {
        const layout = this.layouts.get(pageNumber);
        return layout ? [{ pageNumber, layout, layer: this.pageAnnotationLayer }] : [];
      });
    }
    return this.currentLayout ? [{ pageNumber: this.page, layout: this.currentLayout, layer: this.pageAnnotationLayer }] : [];
  }

  private renderAnnotation(annotation: Annotation, layout: PageLayout, layer: HTMLElement): void {
    if (annotation.kind === "ink") {
      this.renderInk(annotation.points, annotation.color, annotation.baseWidth, layout, layer, "annotation-ink");
      return;
    }
    for (const rect of annotation.rects) {
      const marker = documentElement("div", annotation.kind === "note" ? "annotation-mark note-mark" : "annotation-mark highlight-mark");
      marker.style.left = `${layout.x + rect.x * layout.width}px`;
      marker.style.top = `${layout.y + rect.y * layout.height}px`;
      marker.style.width = `${rect.width * layout.width}px`;
      marker.style.height = `${rect.height * layout.height}px`;
      marker.style.setProperty("--annotation-color", annotation.color);
      layer.append(marker);
    }
    if (annotation.kind === "note") {
      const anchor = annotation.rects.at(-1);
      if (!anchor) return;
      const button = documentElement("button", "annotation-note-button reader-control");
      button.type = "button";
      button.dataset.readerControl = "";
      button.dataset.noteId = annotation.id;
      button.setAttribute("aria-label", `Edit note on page ${annotation.pageNumber}`);
      button.textContent = "✎";
      button.style.left = `${layout.x + (anchor.x + anchor.width) * layout.width - 18}px`;
      button.style.top = `${layout.y + anchor.y * layout.height - 18}px`;
      layer.append(button);
    }
  }

  private renderSelection(selection: TextSelectionState, layout: PageLayout, layer: HTMLElement): void {
    for (const rect of selection.geometry.rects) {
      const marker = documentElement("div", "selection-mark");
      marker.style.left = `${layout.x + rect.x * layout.width}px`;
      marker.style.top = `${layout.y + rect.y * layout.height}px`;
      marker.style.width = `${rect.width * layout.width}px`;
      marker.style.height = `${rect.height * layout.height}px`;
      layer.append(marker);
    }
    for (const [kind, anchor] of [["start", selection.geometry.startHandle], ["end", selection.geometry.endHandle]] as const) {
      const handle = this.selectionHandle(kind);
      handle.style.left = `${layout.x + anchor.x * layout.width}px`;
      handle.style.top = `${layout.y + anchor.y * layout.height}px`;
      handle.style.setProperty("--selection-handle-line", `${Math.max(12, anchor.height * layout.height)}px`);
      layer.append(handle);
    }
  }

  /**
   * Selection handles are reused rather than recreated. A touch keeps its
   * original target element for the whole gesture, so rebuilding a handle while
   * it is being dragged would detach that target and stop every later touchmove
   * from reaching the scene listener.
   */
  private selectionHandle(kind: "start" | "end"): HTMLButtonElement {
    const existing = this.selectionHandles.get(kind);
    if (existing) return existing;
    const handle = documentElement("button", `selection-handle ${kind}`);
    handle.type = "button";
    handle.dataset.readerControl = "";
    handle.dataset.selectionHandle = kind;
    handle.setAttribute("aria-label", `Adjust ${kind} of selection`);
    this.selectionHandles.set(kind, handle);
    return handle;
  }

  private renderInk(points: readonly InkPoint[], color: string, baseWidth: number, layout: PageLayout, layer: HTMLElement, className: string): void {
    if (points.length < 2) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    svg.style.left = `${layout.x}px`;
    svg.style.top = `${layout.y}px`;
    svg.style.width = `${layout.width}px`;
    svg.style.height = `${layout.height}px`;
    for (const segment of inkSegments(points, baseWidth)) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(segment.from.x * layout.width));
      line.setAttribute("y1", String(segment.from.y * layout.height));
      line.setAttribute("x2", String(segment.to.x * layout.width));
      line.setAttribute("y2", String(segment.to.y * layout.height));
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", String(segment.width));
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("stroke-linejoin", "round");
      svg.append(line);
    }
    layer.append(svg);
  }

  private appendPointerInk(event: PointerEvent): void {
    const ink = this.ink;
    if (!ink || ink.pointerId !== event.pointerId) return;
    const samples = event.getCoalescedEvents?.() ?? [];
    const events = samples.length > 0 ? samples : [event];
    let firstChangedPoint = Number.POSITIVE_INFINITY;
    for (const sample of events) {
      const normalized = this.normalizedAtPage({ x: sample.clientX, y: sample.clientY }, ink.pageNumber, true);
      if (!normalized) continue;
      const previousCount = ink.points.length;
      const points = appendInkPoint(ink.points, {
        ...normalized,
        pressure: sample.pressure > 0 ? sample.pressure : 0.5,
        elapsed: Math.max(0, sample.timeStamp - ink.startedAt)
      });
      firstChangedPoint = Math.min(firstChangedPoint, points.length < previousCount ? 1 : points.length === previousCount ? Math.max(0, points.length - 1) : previousCount);
      ink.points = points;
    }
    if (Number.isFinite(firstChangedPoint)) this.syncLiveInkSurface(ink, firstChangedPoint);
  }

  private cancelInk(): void {
    const ink = this.ink;
    this.ink = undefined;
    this.removeLiveInkSurface(ink);
    this.refreshAnnotationOverlays();
  }

  private syncLiveInkSurface(ink: InkState, firstChangedPoint: number): void {
    const target = this.visibleOverlayTargets().find(({ pageNumber }) => pageNumber === ink.pageNumber);
    if (!target || ink.documentId !== this.sidecar?.id) {
      this.removeLiveInkSurface(ink);
      return;
    }
    const surface = this.liveInkSurface;
    if (!surface
      || surface.ink !== ink
      || surface.element.parentElement !== target.layer
      || surface.layout.x !== target.layout.x
      || surface.layout.y !== target.layout.y
      || surface.layout.width !== target.layout.width
      || surface.layout.height !== target.layout.height
      || surface.layout.scale !== target.layout.scale) {
      this.removeLiveInkSurface();
      this.mountLiveInkSurface(ink, target.layout, target.layer);
      return;
    }
    const boundedChangedPoint = Math.max(0, Math.min(firstChangedPoint, surface.renderedPointCount));
    const firstChangedSegment = Math.max(0, boundedChangedPoint - 1);
    while (surface.element.childElementCount > firstChangedSegment) surface.element.lastElementChild?.remove();
    for (let index = firstChangedSegment; index + 1 < ink.points.length; index += 1) {
      const from = ink.points[index];
      const to = ink.points[index + 1];
      if (from && to) surface.element.append(this.liveInkLine(from, to, surface.layout));
    }
    surface.renderedPointCount = ink.points.length;
  }

  private mountLiveInkSurface(ink: InkState, layout: PageLayout, layer: HTMLElement): LiveInkSurface {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    element.setAttribute("class", "annotation-ink live");
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    element.style.left = `${layout.x}px`;
    element.style.top = `${layout.y}px`;
    element.style.width = `${layout.width}px`;
    element.style.height = `${layout.height}px`;
    layer.append(element);
    const surface = { element, ink, layout: { ...layout }, renderedPointCount: 0 };
    this.liveInkSurface = surface;
    this.syncLiveInkSurface(ink, 0);
    return surface;
  }

  private liveInkLine(from: InkPoint, to: InkPoint, layout: PageLayout): SVGLineElement {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const segment = inkSegments([from, to], INK_BASE_WIDTH)[0];
    line.setAttribute("x1", String(from.x * layout.width));
    line.setAttribute("y1", String(from.y * layout.height));
    line.setAttribute("x2", String(to.x * layout.width));
    line.setAttribute("y2", String(to.y * layout.height));
    line.setAttribute("stroke", DEFAULT_INK_COLOR);
    line.setAttribute("stroke-width", String(segment?.width ?? 0));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    return line;
  }

  private removeLiveInkSurface(ink?: InkState): void {
    const surface = this.liveInkSurface;
    if (!surface || ink && surface.ink !== ink) return;
    this.liveInkSurface = undefined;
    surface.element.remove();
  }

  private pageHitAt(point: Point): { pageNumber: number; layout: PageLayout; normalized: NormalizedPoint } | undefined {
    for (const target of this.visibleOverlayTargets()) {
      const normalized = this.normalizedAtPage(point, target.pageNumber);
      if (normalized && normalized.x >= 0 && normalized.x <= 1 && normalized.y >= 0 && normalized.y <= 1) return { ...target, normalized };
    }
    return undefined;
  }

  private normalizedAtPage(point: Point, pageNumber: number, clampToPage = false): NormalizedPoint | undefined {
    const layout = this.layoutMode === "continuous"
      ? this.continuousLayout?.pages[pageNumber - 1]
      : this.layouts.get(pageNumber) ?? (pageNumber === this.page ? this.currentLayout : undefined);
    if (!layout) return undefined;
    const scenePoint = this.layoutMode === "continuous"
      ? { x: point.x, y: point.y + this.continuousScroll }
      : screenToScene(point, this.camera);
    const normalized = { x: (scenePoint.x - layout.x) / Math.max(1, layout.width), y: (scenePoint.y - layout.y) / Math.max(1, layout.height) };
    return clampToPage
      ? { x: Math.min(1, Math.max(0, normalized.x)), y: Math.min(1, Math.max(0, normalized.y)) }
      : normalized;
  }

  private async openOutline(): Promise<void> {
    const document = this.document;
    if (!document) return;
    this.closePanels();
    this.drawerPanel.hidden = false;
    this.panelBackdrop.hidden = false;
    this.drawerTitle.textContent = "Outline";
    this.drawerContent.textContent = "Loading outline…";
    required<HTMLButtonElement>(this.root, "#drawer-close").focus();
    try {
      this.outlineNodes ??= await document.outline();
      if (document !== this.document) return;
      this.flatOutline = flattenOutline(this.outlineNodes);
      this.drawerContent.replaceChildren();
      if (this.flatOutline.length === 0) {
        this.drawerContent.textContent = "This PDF has no outline.";
        return;
      }
      const indexes = new Map(this.flatOutline.map((item, index) => [item.path.join("/"), index]));
      this.drawerContent.append(renderOutlineList(outlineTreeStructure(this.outlineNodes), indexes, true));
    } catch (error) {
      this.drawerContent.textContent = `Outline unavailable: ${errorMessage(error)}`;
    }
  }

  private openRecents(): void {
    this.closePanels();
    this.drawerPanel.hidden = false;
    this.panelBackdrop.hidden = false;
    this.drawerTitle.textContent = "Recents";
    this.drawerContent.replaceChildren();
    required<HTMLButtonElement>(this.root, "#drawer-close").focus();
    if (this.recentSidecars.length === 0) {
      this.drawerContent.textContent = "No recent PDFs.";
      return;
    }
    const list = documentElement("ul", "recents-list");
    for (const sidecar of this.recentSidecars) {
      const row = documentElement("li", "recent-item");
      const button = documentElement("button", "recent-button");
      button.type = "button";
      button.dataset.recentId = sidecar.id;
      button.textContent = sidecar.name;
      row.append(button);
      list.append(row);
    }
    this.drawerContent.append(list);
  }

  private async onDrawerAction(event: Event): Promise<void> {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (button?.dataset.outlineToggle !== undefined) {
      const row = button.closest<HTMLElement>(".outline-item");
      const group = button.parentElement?.nextElementSibling;
      if (row && group instanceof HTMLUListElement) {
        const expanded = row.getAttribute("aria-expanded") === "true";
        row.setAttribute("aria-expanded", String(!expanded));
        button.setAttribute("aria-expanded", String(!expanded));
        button.setAttribute("aria-label", `${expanded ? "Expand" : "Collapse"} ${button.dataset.outlineTitle ?? "section"}`);
        button.textContent = expanded ? "▸" : "▾";
        group.hidden = expanded;
      }
      return;
    }
    const outlineIndex = Number(button?.dataset.outlineIndex);
    if (Number.isInteger(outlineIndex) && outlineIndex >= 0) {
      const item = this.flatOutline[outlineIndex];
      const page = item && this.document ? await this.document.resolveDestination(item.dest) : undefined;
      if (!page) this.showStatus("This bookmark has no valid page destination.", true, 2200);
      else {
        this.closePanels();
        await this.goToPage(page);
      }
      return;
    }
    const recentId = button?.dataset.recentId;
    if (recentId) {
      await this.openRecent(recentId);
      return;
    }
    const deleteId = button?.dataset.deleteAnnotation;
    if (deleteId && this.sidecar) {
      try {
        await deleteAnnotation(this.sidecar.id, deleteId);
        this.annotations = this.annotations.filter(({ id }) => id !== deleteId);
        this.refreshAnnotationOverlays();
        this.openAnnotations();
      } catch (error) {
        this.showStatus(`Unable to delete annotation: ${errorMessage(error)}`, true);
      }
      return;
    }
    const annotationId = button?.dataset.annotationId;
    const annotation = this.annotations.find(({ id }) => id === annotationId);
    if (annotation) {
      this.closePanels();
      await this.goToPage(annotation.pageNumber);
    }
  }

  private async openRecent(id: string): Promise<void> {
    const sidecar = this.recentSidecars.find((item) => item.id === id);
    if (!sidecar) return;
    this.closePanels();
    if (this.openSession.documentIds.includes(id)) {
      await this.switchOpenDocument(id);
      return;
    }
    this.opening = true;
    this.showStatus(`Opening ${sidecar.name}…`);
    try {
      const bytes = await readPdf(id);
      const document = await PdfDocument.open(bytes, { id, name: sidecar.name, byteLength: sidecar.byteLength });
      await this.activate(document, sidecar);
      this.openSidecars.set(id, sidecar);
      this.openSession = addOpenDocument(this.openSession, id);
      await saveOpenSession(this.openSession);
      this.hideStatus();
    } catch (error) {
      this.showStatus(`Recent PDF is unavailable: ${errorMessage(error)}`, true);
    } finally {
      this.opening = false;
      this.renderChrome();
    }
  }

  private rebuildContinuousLayout(): void {
    if (this.pageSizes.length === 0) return;
    this.continuousLayout = layoutContinuous(this.pageSizes, this.viewport(), this.safeInsets());
    const bounds = continuousScrollBounds(this.continuousLayout, this.viewport());
    this.continuousScroll = constrainContinuousScroll(this.continuousScroll, bounds);
  }

  private syncContinuousFocus(): void {
    if (!this.continuousLayout) return;
    this.page = continuousPageAtViewportCenter(this.continuousLayout, this.continuousScroll, this.viewport());
    this.currentLayout = this.continuousLayout.pages[this.page - 1];
    this.gridFocusPage = this.page;
  }

  private startContinuousMomentum(releaseVelocity: number): boolean {
    const layout = this.continuousLayout;
    if (!layout || this.reducedMotion() || Math.abs(releaseVelocity) < 0.05) return false;
    this.cancelContinuousMomentum();
    let velocity = releaseVelocity * 1.4;
    let previousTime = performance.now();
    const advance = (time: number): void => {
      if (this.layoutMode !== "continuous" || this.viewMode !== "reading" || this.continuousLayout !== layout) {
        this.continuousMomentumFrame = undefined;
        return;
      }
      const step = stepContinuousMomentum(
        this.continuousScroll,
        velocity,
        time - previousTime,
        continuousScrollBounds(layout, this.viewport())
      );
      previousTime = time;
      this.continuousScroll = step.scroll;
      velocity = step.velocity;
      this.syncContinuousFocus();
      this.applyTransform();
      if (shouldRefreshContinuousWindow(this.continuousScroll, this.continuousSyncedScroll, this.viewport().height)) {
        void this.refreshContinuousRendering().catch((error) => console.warn("Continuous rendering refresh failed", error));
      }
      if (step.settled) {
        this.continuousMomentumFrame = undefined;
        void this.refreshContinuousRendering().catch((error) => console.warn("Continuous rendering settle failed", error));
        this.queuePositionSave();
        return;
      }
      this.continuousMomentumFrame = requestAnimationFrame(advance);
    };
    this.continuousMomentumFrame = requestAnimationFrame(advance);
    return true;
  }

  private cancelContinuousMomentum(): void {
    if (this.continuousMomentumFrame !== undefined) cancelAnimationFrame(this.continuousMomentumFrame);
    this.continuousMomentumFrame = undefined;
  }

  private cameraBoundsLayout(): PageLayout | undefined {
    if ((this.layoutMode === "twoUp" || this.layoutMode === "twoUpCover") && this.document) {
      const layouts = spreadPageNumbers(this.page, this.document.pageCount, this.layoutMode)
        .map((page) => this.layouts.get(page))
        .filter((layout): layout is PageLayout => layout !== undefined);
      return unionPageLayouts(layouts) ?? this.currentLayout;
    }
    return this.currentLayout;
  }

  private focusedReadingPage(point: Point): number {
    if (!this.document || (this.layoutMode !== "twoUp" && this.layoutMode !== "twoUpCover")) return this.page;
    const scenePoint = screenToScene(point, this.camera);
    const pages = spreadPageNumbers(this.page, this.document.pageCount, this.layoutMode);
    let nearest = this.page;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const page of pages) {
      const layout = this.layouts.get(page);
      if (!layout) continue;
      if (scenePoint.x >= layout.x && scenePoint.x <= layout.x + layout.width
        && scenePoint.y >= layout.y && scenePoint.y <= layout.y + layout.height) return page;
      const nextDistance = Math.hypot(scenePoint.x - (layout.x + layout.width / 2), scenePoint.y - (layout.y + layout.height / 2));
      if (nextDistance < nearestDistance) {
        nearest = page;
        nearestDistance = nextDistance;
      }
    }
    return nearest;
  }

  private focusSpreadPage(page: number): void {
    if (!this.document || (this.layoutMode !== "twoUp" && this.layoutMode !== "twoUpCover")) return;
    if (!spreadPageNumbers(this.page, this.document.pageCount, this.layoutMode).includes(page)) return;
    const layout = this.layouts.get(page);
    if (!layout) return;
    this.page = page;
    this.currentLayout = layout;
    this.gridFocusPage = page;
  }

  private clearLayoutCanvases(preserveSingle = false): void {
    for (const canvas of this.spreadCanvases.values()) canvas.remove();
    for (const canvas of this.continuousCanvases.values()) canvas.remove();
    this.spreadCanvases.clear();
    this.continuousCanvases.clear();
    this.continuousSyncedScroll = Number.NaN;
    this.continuousHitLayer.replaceChildren();
    this.pageHitLayer.replaceChildren();
    this.continuousAnnotationLayer.replaceChildren();
    this.pageAnnotationLayer.replaceChildren();
    if (!preserveSingle) {
      this.canvases.previous.hidden = true;
      this.canvases.current.hidden = true;
      this.canvases.next.hidden = true;
    }
  }

  private startPanelMomentum(element: HTMLElement, releaseVelocity: number): void {
    if (this.reducedMotion() || Math.abs(releaseVelocity) < 0.03) return;
    this.cancelPanelMomentum();
    let velocity = releaseVelocity * 1.25;
    let previousTime = performance.now();
    const advance = (time: number): void => {
      if (!element.isConnected || this.findPanel.hidden && this.drawerPanel.hidden) {
        this.panelMomentumFrame = undefined;
        return;
      }
      const step = stepPanelMomentum(
        element.scrollTop,
        velocity,
        time - previousTime,
        element.scrollHeight,
        element.clientHeight
      );
      previousTime = time;
      element.scrollTop = step.scrollTop;
      velocity = step.velocity;
      if (step.reachedBoundary || Math.abs(velocity) < 0.015) {
        this.panelMomentumFrame = undefined;
        return;
      }
      this.panelMomentumFrame = requestAnimationFrame(advance);
    };
    this.panelMomentumFrame = requestAnimationFrame(advance);
  }

  private cancelPanelMomentum(): void {
    if (this.panelMomentumFrame !== undefined) cancelAnimationFrame(this.panelMomentumFrame);
    this.panelMomentumFrame = undefined;
  }

  private showStatus(message: string, error = false, hideAfter?: number): void {
    if (this.statusTimer !== undefined) window.clearTimeout(this.statusTimer);
    this.status.textContent = message;
    this.status.hidden = false;
    this.status.classList.toggle("error", error);
    if (hideAfter !== undefined) this.statusTimer = window.setTimeout(() => this.hideStatus(), hideAfter);
  }

  private hideStatus(): void {
    this.status.hidden = true;
    this.status.textContent = "";
  }

  private installHistoryDefense(): void {
    history.replaceState({ mreader: "root" }, "");
    history.pushState({ mreader: "guard" }, "");
    window.addEventListener("popstate", () => history.pushState({ mreader: "guard" }, ""));
  }

  private async registerServiceWorker(): Promise<void> {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  }

  private ensureGridLayout(): void {
    if (this.gridLayout || !this.currentLayout || !this.document) return;
    if (this.pageSizes.length !== this.document.pageCount) {
      this.pageSizes = Array.from({ length: this.document.pageCount }, () => ({
        width: this.currentLayout?.width ?? 1,
        height: this.currentLayout?.height ?? 1
      }));
    }
    this.rebuildGridLayout();
  }

  private rebuildGridLayout(): void {
    if (this.pageSizes.length === 0) return;
    this.gridLayout = layoutGrid(this.pageSizes, this.viewport(), this.safeInsets());
  }

  private prepareGrid(): Promise<void> {
    const document = this.document;
    if (!document) return Promise.resolve();
    if (this.gridSizesReady) return Promise.resolve();
    if (this.gridPreparation) return this.gridPreparation;
    const generation = ++this.gridGeneration;
    this.gridPreparation = (async () => {
      const sizes = [...this.pageSizes];
      for (let start = 0; start < document.pageCount; start += 8) {
        const pageNumbers = Array.from({ length: Math.min(8, document.pageCount - start) }, (_, index) => start + index + 1);
        const batch = await Promise.all(pageNumbers.map((pageNumber) => document.pageSize(pageNumber)));
        if (document !== this.document || generation !== this.gridGeneration) return;
        for (let index = 0; index < batch.length; index += 1) {
          const size = batch[index];
          if (size) sizes[start + index] = size;
        }
        await wait(0);
      }
      if (document !== this.document || generation !== this.gridGeneration) return;
      this.pageSizes = sizes;
      this.gridSizesReady = true;
      this.rebuildGridLayout();
      if (this.gridLayout && this.viewMode === "grid") {
        this.gridOffset = gridOffsetForPage(this.gridLayout, this.gridFocusPage, this.viewport(), this.safeInsets());
        this.applyTransform();
        this.syncGridThumbnails();
      }
    })().finally(() => {
      if (generation === this.gridGeneration) this.gridPreparation = undefined;
    });
    return this.gridPreparation;
  }

  private enterGridDuringPinch(pageNumber: number): void {
    this.ensureGridLayout();
    this.gridFocusPage = pageNumber;
    if (this.gridLayout) this.gridOffset = gridOffsetForPage(this.gridLayout, pageNumber, this.viewport(), this.safeInsets());
    this.gridLayer.hidden = false;
    this.syncGridThumbnails();
  }

  private async enterGridFromControl(): Promise<void> {
    if (!this.document || !this.currentLayout || this.viewMode === "grid") return;
    this.cancelSelection();
    this.cancelInk();
    this.clearPendingTap();
    this.cancelGridMomentum();
    this.cancelContinuousMomentum();
    this.ensureGridLayout();
    this.gridFocusPage = this.page;
    this.gridLayer.hidden = false;
    this.applyTransform();
    void this.prepareGrid().catch((error) => this.showStatus(`Grid preparation failed: ${errorMessage(error)}`, true));
    if (!this.gridLayout) return;
    this.gridOffset = gridOffsetForPage(this.gridLayout, this.page, this.viewport(), this.safeInsets());
    this.gridOverscroll = 0;
    this.gridBounce = 0;
    this.syncGridThumbnails();
    this.gridLayer.classList.add("semantic-settling");
    this.track.classList.add("semantic-settling");
    await nextFrame();
    this.viewMode = "grid";
    this.semanticZoom = GRID_REST_SCALE;
    this.camera = { x: 0, y: 0, scale: 1 };
    this.fit = "page";
    this.applyTransform();
    await wait(this.semanticSettleDuration());
    this.gridLayer.classList.remove("semantic-settling");
    this.track.classList.remove("semantic-settling");
    this.renderChrome();
  }

  private async exitGrid(pageNumber: number): Promise<void> {
    this.clearPendingTap();
    this.cancelGridMomentum();
    await this.prepareFocusedPage(pageNumber);
    this.viewMode = "reading";
    this.semanticZoom = 1;
    this.gridGesture = undefined;
    this.setPageFit();
    this.gridLayer.classList.add("semantic-settling");
    this.track.classList.add("semantic-settling");
    this.applyTransform();
    await this.refreshRendering();
    await wait(this.semanticSettleDuration());
    this.gridLayer.classList.remove("semantic-settling");
    this.track.classList.remove("semantic-settling");
    this.gridLayer.hidden = true;
    this.thumbnailRenderer.cancel();
    this.queuePositionSave();
    this.renderChrome();
  }

  private async prepareFocusedPage(pageNumber: number): Promise<void> {
    const document = this.document;
    if (!document) return;
    const boundedPage = Math.min(document.pageCount, Math.max(1, pageNumber));
    this.gridFocusPage = boundedPage;
    if (boundedPage === this.page && this.currentLayout) {
      if (this.viewMode === "grid") this.syncGridThumbnails();
      return;
    }
    this.page = boundedPage;
    this.fit = "page";
    this.camera = { x: 0, y: 0, scale: 1 };
    this.layouts.clear();
    this.currentLayout = await this.layoutFor(this.page);
    if (this.layoutMode === "continuous") {
      this.rebuildContinuousLayout();
      if (this.continuousLayout) this.continuousScroll = continuousScrollForPage(this.continuousLayout, this.page, this.viewport());
    }
    this.setPageFit();
    this.canvases.current.setAttribute("aria-label", `Page ${this.page} of ${document.pageCount}`);
    await this.refreshRendering();
    if (this.viewMode === "grid") this.syncGridThumbnails();
    this.queuePositionSave();
  }

  private updateReadingCameraFromGridPinch(pageNumber: number): void {
    const grid = this.gridLayout;
    const layout = this.currentLayout;
    const gridCamera = this.gridGesture;
    const item = grid?.pages[pageNumber - 1];
    if (!grid || !layout || !gridCamera || !item || this.page !== pageNumber) return;
    const progress = Math.min(1, Math.max(0, (this.semanticZoom - GRID_REST_SCALE) / (GRID_EXIT_SCALE - GRID_REST_SCALE)));
    const itemCenter = {
      x: item.x + item.width / 2,
      y: item.y + item.height / 2
    };
    const screenCenter = {
      x: itemCenter.x * gridCamera.scale + gridCamera.x,
      y: itemCenter.y * gridCamera.scale + gridCamera.y
    };
    const thumbnailScale = Math.max(0.01, item.width * gridCamera.scale / Math.max(layout.width, 1));
    const targetX = screenCenter.x - (layout.x + layout.width / 2) * thumbnailScale;
    const targetY = screenCenter.y - (layout.y + layout.height / 2) * thumbnailScale;
    this.camera = {
      scale: thumbnailScale + (1 - thumbnailScale) * progress,
      x: targetX * (1 - progress),
      y: targetY * (1 - progress)
    };
  }

  private updateGridCameraFromReadingPinch(pageNumber: number): void {
    const grid = this.gridLayout;
    const layout = this.currentLayout;
    const item = grid?.pages[pageNumber - 1];
    if (!grid || !layout || !item) return;
    const pageCenter = sceneToScreen({
      x: layout.x + layout.width / 2,
      y: layout.y + layout.height / 2
    }, this.camera);
    const itemCenter = {
      x: item.x + item.width / 2,
      y: item.y + item.height / 2
    };
    const expandedScale = Math.max(0.01, layout.width * this.camera.scale / Math.max(item.width, 1));
    const expanded = {
      scale: expandedScale,
      x: pageCenter.x - itemCenter.x * expandedScale,
      y: pageCenter.y - itemCenter.y * expandedScale
    };
    this.gridGesture = interpolateSemanticTransform(
      expanded,
      { x: this.gridOffset, y: 0, scale: 1 },
      semanticTransitionProgress(this.semanticZoom)
    );
  }

  private focusedGridPage(point: Point): number {
    if (!this.gridLayout) return this.page;
    return nearestGridPage(this.gridLayout, this.gridOffset, point);
  }

  private syncGridThumbnails(): void {
    const document = this.document;
    const grid = this.gridLayout;
    if (!document || !grid) return;
    this.gridSyncedOffset = this.gridOffset;
    const pages = visibleGridPages(grid, this.gridOffset, this.viewport(), 1);
    const visible = new Set(pages.map((page) => page.pageNumber));
    for (const [pageNumber, canvas] of this.thumbnailCanvases) {
      if (visible.has(pageNumber)) continue;
      canvas.remove();
      this.thumbnailCanvases.delete(pageNumber);
    }
    const specs: ThumbnailRenderSpec[] = [];
    for (const page of pages) {
      let canvas = this.thumbnailCanvases.get(page.pageNumber);
      if (!canvas) {
        canvas = documentElement("canvas", "thumbnail-page");
        canvas.setAttribute("role", "listitem");
        canvas.setAttribute("aria-label", `Page ${page.pageNumber}`);
        this.gridLayer.append(canvas);
        this.thumbnailCanvases.set(page.pageNumber, canvas);
      }
      canvas.style.left = `${page.x}px`;
      canvas.style.top = `${page.y}px`;
      canvas.style.width = `${page.width}px`;
      canvas.style.height = `${page.height}px`;
      canvas.classList.toggle("focused", page.pageNumber === this.gridFocusPage);
      const rowDistance = Math.abs(page.pageNumber - this.gridFocusPage);
      specs.push({
        pageNumber: page.pageNumber,
        canvas,
        cssWidth: page.width,
        cssHeight: page.height,
        dpr: Math.min(Math.max(window.devicePixelRatio, 1), 2),
        priority: rowDistance
      });
    }
    void this.thumbnailRenderer.settle(document, specs);
  }

  private clearThumbnailElements(): void {
    for (const canvas of this.thumbnailCanvases.values()) canvas.remove();
    this.thumbnailCanvases.clear();
    this.gridSyncedOffset = Number.NaN;
  }

  private startGridMomentum(releaseVelocity: number): boolean {
    const grid = this.gridLayout;
    if (!grid || Math.abs(releaseVelocity) < 0.05) return false;
    this.cancelGridMomentum();
    let velocity = releaseVelocity * 1.5;
    let previousTime = performance.now();
    const advance = (time: number): void => {
      if (this.viewMode !== "grid" || this.gridLayout !== grid) {
        this.gridMomentumFrame = undefined;
        return;
      }
      const step = stepGridMomentum(this.gridOffset, velocity, time - previousTime);
      previousTime = time;
      const constrained = constrainGridOffset(step.offset, grid, this.viewport(), this.safeInsets());
      const reachedBound = Math.abs(constrained - step.offset) > 0.1;
      this.gridOffset = constrained;
      velocity = step.velocity;
      if (reachedBound && !this.reducedMotion()) {
        this.gridBounce = rubberBandDisplacement(step.offset - constrained + velocity * 12);
      }
      this.applyTransform();
      if (shouldRefreshGridWindow(this.gridOffset, this.gridSyncedOffset, this.viewport().width)) {
        this.syncGridThumbnails();
      }
      if (reachedBound || Math.abs(velocity) < 0.02) {
        this.gridMomentumFrame = undefined;
        if (reachedBound && Math.abs(this.gridBounce) > 0.01) {
          this.startGridSpring(velocity * 0.15);
          return;
        }
        this.syncGridThumbnails();
        void this.prepareFocusedPage(this.focusedGridPage({ x: this.viewport().width / 2, y: this.viewport().height / 2 }));
        return;
      }
      this.gridMomentumFrame = requestAnimationFrame(advance);
    };
    this.gridMomentumFrame = requestAnimationFrame(advance);
    return true;
  }

  private startGridSpring(initialVelocity: number): void {
    if (this.gridMomentumFrame !== undefined) cancelAnimationFrame(this.gridMomentumFrame);
    this.gridMomentumFrame = undefined;
    this.gridOverscroll = 0;
    if (this.reducedMotion()) {
      this.gridBounce = 0;
      this.applyTransform();
      this.syncGridThumbnails();
      return;
    }
    let velocity = initialVelocity;
    let previousTime = performance.now();
    const advance = (time: number): void => {
      if (this.viewMode !== "grid") {
        this.gridMomentumFrame = undefined;
        this.gridBounce = 0;
        return;
      }
      const step = stepGridSpring(this.gridBounce, velocity, time - previousTime);
      previousTime = time;
      this.gridBounce = step.displacement;
      velocity = step.velocity;
      this.applyTransform();
      if (step.settled) {
        this.gridMomentumFrame = undefined;
        this.syncGridThumbnails();
        void this.prepareFocusedPage(this.focusedGridPage({ x: this.viewport().width / 2, y: this.viewport().height / 2 }));
        return;
      }
      this.gridMomentumFrame = requestAnimationFrame(advance);
    };
    this.gridMomentumFrame = requestAnimationFrame(advance);
  }

  private cancelGridMomentum(): void {
    if (this.gridMomentumFrame !== undefined) cancelAnimationFrame(this.gridMomentumFrame);
    this.gridMomentumFrame = undefined;
    this.gridOverscroll = 0;
    this.gridBounce = 0;
  }

  private semanticSettleDuration(): number {
    return this.reducedMotion() ? 1 : 180;
  }

  private reducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Required reader element is missing: ${selector}`);
  return element;
}

function documentElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function renderOutlineList(items: readonly OutlineTreeItem[], indexes: ReadonlyMap<string, number>, root: boolean): HTMLUListElement {
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
async function writeClipboardText(text: string): Promise<boolean> {
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

function touchPoint(touch: Touch | undefined): Point | undefined {
  return touch ? { x: touch.clientX, y: touch.clientY } : undefined;
}

function touchPoints(touches: TouchList): [Point, Point] | undefined {
  const first = touchPoint(touches[0]);
  const second = touchPoint(touches[1]);
  return first && second ? [first, second] : undefined;
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button,input,[data-reader-control]") !== null;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

function pixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

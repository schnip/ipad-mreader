# mreader

A clean-room, default-chromeless PDF reader PWA targeting an iPad Air 5. P5 adds custom text highlights and notes plus pressure-sensitive Pencil ink to the physically signed-off P0–P4 reader. It uses vanilla TypeScript and `pdfjs-dist` core APIs, not the bundled PDF.js viewer or a UI framework.

## Run and install

```bash
yarn install
yarn dev
```

OPFS and service workers require HTTPS. Do not use a plain LAN `http://` URL from the iPad. Put Vite behind `tailscale serve` or a Cloudflare tunnel, or deploy `yarn build` output from `dist/` to an HTTPS static host. Open the HTTPS URL in Safari, choose **Share → Add to Home Screen**, and launch the installed app.

Each successful production build ends with `mreader build YYYYMMDDHHMMSS`; compare that value with the UTC build number exposed by the app.

### iOS app via SideStore (scaffolding)

`yarn build:ios` builds the web assets with the native platform seam (no service worker), and `yarn sync:ios` also runs `cap sync ios`. The IPA must be compiled on macOS: `.github/workflows/ios-ipa.yml` runs on a GitHub macOS runner (manually or on an `ios-v*` tag), builds `mreader-<build number>.ipa` unsigned, and attaches it to a Release on tag pushes. SideStore re-signs it on the iPad with a free Apple ID (7-day refresh). The wrapped app's OPFS/IndexedDB data is separate from the installed PWA. Ingress, export, and OPFS under `capacitor://` are not yet implemented or verified on iOS.

On first launch, choose **Open PDF**. The selected bytes are copied into OPFS and remain on the device. Imports join an ordered open-document session and become current. Later launches restore only that explicit session—not every recent PDF—and restore each document's own page and camera position when selected. Closing a session tab does not delete its OPFS bytes or sidecar. To import another PDF while the controls are hidden, tap the nearly invisible dot in the safe top-right corner; its 44-point target is also keyboard-focusable. Pressing `O` opens the picker when a keyboard is connected.

Installed Chromium PWAs on desktop register as PDF file handlers and import files received through **Open with**. On Android, Chromium does not expose PWA file handlers, but the installed app registers as a PDF share target: choose **Share → mreader** in the source app. iOS/iPadOS Safari currently supports neither PWA file handlers nor Web Share Targets, so **Open PDF** remains the required ingress there. All supported ingress paths copy the selected bytes into the same app-owned OPFS storage; they never modify the source file.

## Reading and semantic-zoom interactions

- Swipe horizontally at fit-page scale to turn pages. The outgoing page follows the finger and the adjacent page is pre-rendered and visible during the drag. Center and edge swipes use the same path. One rapid consecutive flick made during an active settle is buffered with its release velocity and begins after that turn commits; the behavior can chain across successive settles.
- Spread two fingers to zoom into a page, then drag one finger to pan. Pinch the fingers together far enough to shrink continuously through the semantic threshold into the thumbnail grid during that same gesture. When starting zoomed in, the gesture first passes back through fitted-page scale and then into the grid.
- In the grid, each thumbnail has a small page number in its existing margin. Drag horizontally with one finger to move through pages; releasing carries momentum that decays against the first/last bounds. Vertical and diagonal-vertical drags intentionally do nothing and never turn a page. Two viewports of thumbnails are mounted around the visible window; offscreen thumbnails are prefetched at 0.6x resolution and upgrade when visible so fast movement is less likely to outrun rasterization. Visible thumbnails are rasterized at up to 1.5x device pixels, a deliberate cap that keeps 128 cached thumbnails inside 32 MiB.
- Tap a thumbnail to select that page and return to fitted single-page reading. Spread two fingers while the grid is visible to return continuously around the thumbnail under the pinch; the focused page is prepared at settle so the page remains spatially coherent through the transition.
- Double-tap a reading page to switch from fit-page to page-width zoom when the width change is meaningful. Double-tap again returns through a subtle focal-coherent transform; Reduce Motion makes that transform immediate. `0` returns to fit-page from either the reading page or the focused grid page.
- Single-tap the generous center region of a reading page to show or hide the safe-area-aware top and bottom bars. Tap the left or right edge to move to the previous or next legal page/spread. Single taps wait through the double-tap interval, so a page-width double tap never flashes chrome or navigates. The next backdrop tap or `Escape` hides the bars. Controls own their touches and cannot leak into page turns, pans, or semantic zoom.
- The top bar shows only explicitly open documents, in session order. Select a tab to switch and restore its sidecar; close it to remove it only from the session. Closing current selects the tab to its right, or the one to its left at the end. Closing all returns to the Open PDF state.
- **Page** and **Grid** retain the semantic scene. **More** selects Single page, Two pages, Two pages with cover, or Continuous and exposes Outline, Recents, Annotations, Export annotated copy, and a read-only Storage report (stored bytes, PDFs no document references, and duplicate imports; nothing is ever deleted). Layout selection is persisted per document without changing v1 sidecar/session databases.
- Two-page mode groups 1–2, 3–4, and so on; cover-aware mode presents page 1 alone, then 2–3, 4–5, and so on. Horizontal fit-scale swipes turn by spread and preserve tracked release velocity through the unchanged bounded settle curve rather than snapping after lift. The legal previous and next whole spreads are pre-rasterized at bounded horizontal slots and promoted synchronously, so mixed dimensions, odd boundaries, and buffered rapid consecutive turns remain visible and coherent. Pinch/pan constrains the union of both current pages while semantic-grid focus remains one focused page.
- Continuous mode lays pages vertically at fitted width. Vertical drags scroll with bounded exponential-decay momentum; horizontal/diagonal-horizontal drags intentionally do not turn pages. The centered page is the persisted/semantic focus throughout drag and inertia. Only the visible full-resolution canvases plus one viewport of overscan are mounted and rasterized, including for 792-page documents.
- **Find** supports `Cmd/Ctrl+F` and unmodified `F`, cancellable batched scanning, progress, scanned/no-text reporting, result contexts, exact page navigation, previous/next, and all/current hit highlights. Hit rectangles never enable native selection or steal gestures. `Escape` closes the foremost panel before hiding chrome.
- Outline renders nested accessible tree groups with independent expand/collapse disclosure controls and resolves named, indexed, and referenced PDF destinations; invalid destinations report gracefully. Recents come only from stored sidecars, are stably deduplicated newest-first by PDF fingerprint or name and byte length, remain separate from open tabs, and reopen/add a selected PDF to the session. Deduplication never merges storage or explicit session tabs. A missing OPFS file reports gracefully. Neither view deletes files or sidecars.
- Links embedded in PDF pages remain aligned and keyboard-accessible in Single, both spread layouts, and Continuous. Internal destinations and bounded first/previous/next/last-page actions navigate in-app; safe web, email, and telephone URLs require confirmation before opening separately. Link controls are inactive in the thumbnail grid and own their taps so they cannot trigger selection, page turns, panning, or chrome.
- Long-press searchable text with one finger to enter custom character-level selection. Drag the selection or its owned start/end handles, then Copy, Highlight, Add note, or Cancel. Copy writes the selected text to the system clipboard and clears the selection. Touching or dragging away from the selection dismisses it — a tap clears the selection and is consumed rather than toggling chrome or navigating, and a swipe or pan starting in unused space clears the selection and proceeds as a normal page turn, pan, or scroll, while touches inside the selection or on its handles still adjust it. Selection and annotation geometry is normalized to the PDF page, remains aligned under camera zoom/pan and every reading layout, and never enables native selection. A page without searchable text reports gracefully.
- Highlights retain selected text/context. Notes use an app-owned textarea editor, not a browser prompt. **More → Annotations** lists the current PDF's annotations in page/time order; selecting one navigates to its exact page and its explicit Delete action removes only that annotation. Closing a session tab does not delete annotations.
- **More → Export annotated copy** writes a new PDF with highlights, numbered note marks plus a matching notes-summary page, and Pencil ink burned in, then shows an **Annotated copy ready** drawer. Tapping **Share annotated copy** opens the system share sheet from that fresh tap (Safari only allows sharing shortly after user activation, which a long preparation would outlast); if sharing is unavailable or the activation still expired, the copy downloads instead. The original OPFS bytes are never modified.
- Apple Pencil uses Pointer Events and coalesced samples where available to draw pressure-sensitive page-local ink in Single, both spread modes, and Continuous. Strokes are bounded/coalesced and persist atomically only on pointer-up; cancellation or document/layout changes discard the live stroke. Pencil does not draw in the grid or controls and never starts finger gestures.
- Native Safari zoom, page rubber-banding, and back navigation remain suppressed. The grid alone has a subtle bounded end rubber band while dragging or flicking, then springs to a legal offset; approved inertial momentum is otherwise unchanged. Apple Pencil input is exclusively claimed and never starts a pan, page turn, continuous scroll, grid scroll, semantic zoom, or control gesture.

The reading view still launches and enters each document with bars hidden; controls and panels overlay the scene. Tapping the backdrop closes Find, More, Outline, Recents, Annotations, or the note editor. All controls own their touches, and Find plus the drawers use dedicated owned vertical drag scrolling with bounded release momentum on iPad. Typing focus suppresses reader shortcuts—including `O`, `F`, `0`, and arrows—except `Escape` and intentional `Cmd/Ctrl+F`. The empty state carries the UTC build number; after load the corner import affordance exposes it in its title and accessible label. Navigations are network-first with a 4-second fallback to the cached shell, under a per-build service-worker cache named `mreader-p6-<build number>` that precaches every emitted file (including the lazily loaded export chunk). Activation deletes only this app's older `mreader-` caches and keeps the newest previous build so a still-open window can finish loading its own chunks. The manifest and icons are fetched network-first so redeploys reach installed apps. Worker activation claims open windows without forcibly navigating them, so an update cannot interrupt the Files picker or an in-progress import; relaunch the online app to load a newly deployed build.

## Architecture

- `src/core/doc.ts`: lifecycle-safe wrapper around `pdfjs-dist` document, page, worker, render-task, non-retaining page-size/text probes, outline retrieval, and destination resolution.
- `src/core/layout.ts`: pure safe-area-aware single/spread/continuous geometry, cover-aware grouping, layout normalization, meaningful-width-zoom decisions, continuous bounds/focus, and bounded visible/overscan selection.
- `src/core/search.ts`: pure Unicode/whitespace normalization, cross-item matching, context, generation cancellation, and async bounded batched scanning. Only hits and the current overlay page survive scanning.
- `src/core/outline.ts`: pure recursive flattening and validated indexed/reference destination targets.
- `src/core/links.ts`: defensive PDF link annotation filtering, cropped/rotated viewport rectangle normalization, safe external-protocol validation, and internal destination/action models.
- `src/core/annotations.ts`: pure defensive annotation models, normalized page-local geometry, character hit-testing/range rectangles and handles, stable identity/order helpers, pressure widths, and bounded ink sampling/segments.
- `src/core/export-geometry.ts`: pure PDF.js-compatible viewport geometry that inverts the cropped, rotated view transform back into PDF user space.
- `src/core/export.ts`: annotated-copy generation and note-summary layout, with `pdf-lib` loaded lazily so the reader's launch bundle is unchanged.
- `src/core/grid.ts`: pure adaptive horizontal grid geometry, mixed-aspect column layout, safe-viewport-derived rows, approved momentum decay, legal pan bounds, bounded rubber-band displacement and spring steps, visible/overscan selection, bounded mid-drag virtual-window refresh, focus centering, and tap hit-testing.
- `src/core/scene.ts`: pure reading-camera constraints and scene/screen coordinate transforms.
- `src/core/gestures.ts`, `src/core/chrome.ts`, `src/core/view-controls.ts`, and `src/core/semantic.ts`: pure gesture/release and center/double-tap decisions, view-control state, pinch geometry, threshold hysteresis, semantic-layer progression, and bidirectional focused-page transform interpolation.
- `src/core/render.ts`: DPR-aware settled page rasterization, stale-task cancellation, adjacent-page scheduling, pre-allocation high-zoom canvas limits, and a bounded weighted LRU page cache.
- `src/core/thumbs.ts`: tiered-resolution, generation-cancelled thumbnail scheduling with a 128-entry/32 MiB weighted LRU. PDF.js already interprets pages in its own worker, so rendered thumbnail canvases are cached directly; the former thumbnail worker only copied finished bitmaps and is retired.
- `src/core/math.ts` and `src/core/tuning.ts`: shared numeric guards and every named reader timing/threshold (the signed-off values, named rather than retuned).
- `src/store/idb.ts`: shared raw IndexedDB plumbing. Connections close on `versionchange`, and each request is awaited together with its transaction so a failure is reported once and never as an unhandled rejection.
- `src/reader/`: controllers split out of `reader.ts` — `panels.ts` (one open panel at a time, focus return), `search-controller.ts` (Find and hit marks), `links-controller.ts` (PDF link buttons), `import-queue.ts` (serialized ingress), and `dom.ts` helpers.
- `src/store/opfs.ts`: imported PDF byte persistence, listing, reading, and deletion in an app-owned OPFS directory.
- `src/store/sidecar.ts`: raw IndexedDB document metadata, recents, normalized reading positions, and optional non-single layout. The v1 format/database remains in place: absent or invalid layout migrates safely to Single page. Updates avoid awaiting between dependent requests in a live transaction.
- `src/store/session.ts`: separate raw IndexedDB v1 store for ordered open IDs and current ID. Pure normalization deduplicates, preserves order, filters missing documents, and repairs current selection without turning recents into open tabs.
- `src/store/annotations.ts`: separate raw IndexedDB v1 annotation store with document/page indexes, defensive reads, and individual document-scoped puts/deletes; sidecar v1 and original OPFS PDF bytes remain untouched.
- `src/reader.ts`: DOM adapter for the semantic page/grid scene, buffered consecutive paginated flicks, role-safe promoted canvas refresh, bounded continuous canvas window, distinct visible-window search/annotation layers, custom selection/note UI, Pointer Events Pencil ink, and transient chrome/panels. Document switches generation-cancel stale page, thumbnail, search, annotation, and buffered gesture work and restore each sidecar. Legal grid state remains separate from visual bounce.

P0 probe modules remain in the source tree for diagnostic reference only; they are excluded from `tsc` and lint. `src/main.ts` starts the reader.

## Retained physical-device results

- P0 PDF benchmark: 792 pages, 32 ms average, 80 ms p95, 237 ms maximum.
- OPFS: verified with 72 ms write, 10 ms read, and 38.4 GiB quota.
- Installed mode: no Safari controls were visible.
- Apple Pencil passed at fit and zoomed scales and did not initiate page turns.
- Finger-following center/edge swipe, navigation defense, custom pinch ownership, and visible adjacent-page rendering passed.
- The P1 physical-iPad pass succeeded for import/relaunch restoration, chromeless reading, rotation and safe areas, page-width double-tap, high-zoom settling, large-document cache pressure, alternate import, center/edge swipes, and Pencil isolation.
- The focused P1 retest also passed: short releases now settle with adaptive remaining-distance timing, and rapid repeated turns unlock when the visual transition ends rather than waiting for background rendering. P1 is complete.

## P2 physical-iPad result (complete)

P2 is physically signed off on the installed iPad Air 5. The initial pass covered continuous threshold entry, thumbnail taps, large-document virtualization/cache behavior, worker/fallback completion, P1 regression, and PWA behavior. The focused retest passed horizontal scrolling and momentum, vertical/diagonal-vertical no-op behavior, end bounds, and portrait-landscape-portrait row/layout correction. Grid-to-page motion is accepted despite remaining eligible for nonessential smoothness polish. The approved momentum feel is retained in P3.

## P3 physical-iPad result (complete)

P3 is physically signed off on the installed iPad Air 5. Delayed center taps, double-tap cancellation without chrome flash, safe-area/control touch ownership, ordered multi-document restoration, deterministic non-destructive closes, Page/Grid controls, bounded grid bounce, P1/P2 regressions, Files-picker-safe updating, and cache ownership all passed. Reduce Motion remains supported through `prefers-reduced-motion`, but it is not a required personal-device sign-off item.

## P4 physical-iPad result (complete)

P4-v5 is physically signed off, including interaction polish, coherent horizontal release velocity, enlarged center taps, delayed edge taps, promoted-canvas preservation, and one buffered rapid flick per active settle. Its page/grid/Continuous momentum and buffered-flick curves are retained unchanged in P5.

## P5 physical-iPad result (complete)

P5 is physically signed off on the installed iPad Air 5. Custom character-level selection, both draggable 44-point handles with line-aligned caret bars, Copy to the system clipboard, highlights, the owned note editor, the annotation index with per-item deletion, and pressure-sensitive Pencil ink all passed in every reading layout, as did the P4-v5 gesture regressions. Two rounds of fixes were required: selection handles are reused DOM nodes because a touch keeps its original target for the whole gesture, and a gesture beginning outside the selection now dismisses it — consuming a dismissing tap while letting a swipe in unused space turn the page. Apple Pencil double-tap/squeeze remains inert because Safari does not expose UIPencilInteraction to web content. The checklist below is retained as the regression procedure.

1. In Single at fit and page-width/custom zoom, long-press text, drag in both directions, cross text items/lines, adjust both 44-point handles after the selection exists, and create a highlight and note. Verify both handles drag, the caret bars align with the text line, Copy places the selected text on the clipboard, character-level geometry, no native selection, no accidental tap/swipe, and graceful behavior over blank/image-only areas. Verify a tap in unused space dismisses the selection without toggling chrome or navigating, and a swipe starting in unused space still turns the page while clearing the selection.
2. Repeat selection/highlight/note alignment in two-up, cover-aware (including page 1), and Continuous before/after scrolling. Rotate, zoom/pan, pinch during selection, switch page/layout/document, and confirm selection cancels safely while persisted annotations remain aligned.
3. Edit notes with the owned textarea and keyboard, dismiss with Close/backdrop/Escape, and verify reader shortcuts remain suppressed while typing. Relaunch online/offline and reopen/close tabs to confirm annotation persistence is independent from session membership and original PDFs remain unchanged.
4. Open **More → Annotations**, momentum-scroll a long list, select each annotation kind, and verify exact page navigation in every layout. Delete one highlight, one note, and one ink stroke and verify only that item disappears; Recents, OPFS files, sidecars, and session tabs must remain.
5. Draw short, long, slow, and fast Pencil strokes with changing pressure in all reading layouts and at zoom/pan. Verify live width response, coalesced smoothness, alignment, bounded long strokes, atomic persistence on lift, and discard on pointer cancel/document/layout switch. Verify Pencil does nothing in grid/controls and never starts finger navigation. Apple Pencil double-tap/squeeze is a native UIPencilInteraction gesture that Safari does not expose to web content, so it intentionally does nothing; erasing remains deferred to P6.
6. Regress P4-v5 slow/fast page turns, chained buffered flicks, held-second-flick handoff, grid/Continuous momentum, center/edge taps, 330 ms double-tap suppression, rotation, Files-picker-safe update, and offline launch. Edge navigation deliberately retains the full delay without a preview to avoid sharing/destabilizing the signed-off page-track settle surface. Confirm the `mreader-p6-<build number>` cache matches the build number shown by the app.

## P6 physical-iPad checklist (pending)

1. Export a document containing highlights, notes, and Pencil ink. Confirm the system share sheet appears and that copies opened from Files and Books place all three annotation kinds correctly.
2. Verify annotation placement on rotated pages and across mixed-size pages.
3. Confirm each numbered on-page note marker matches its entry on the appended notes-summary page.
4. Confirm exported ink widths look right; `AUTHORING_VIEWPORT_WIDTH` remains a tunable approximation because strokes do not store their authoring viewport width.
5. Attempt export with zero annotations and confirm the app reports that there are no annotations to export.
6. Export a large document and confirm preparation and sharing complete successfully.
7. Reopen the original PDF and confirm it is unchanged, with its reading position and sidecar annotations intact after export.
8. Cancel the system share sheet and confirm cancellation closes cleanly without an error.
9. Follow embedded table-of-contents links in Single, both spread layouts, and Continuous; verify named and referenced destinations land on the correct page before and after rotation and zoom/pan.
10. Exercise first/previous/next/last-page PDF actions at document bounds. Confirm safe web, email, and telephone links show the complete confirmation URL, open separately only after approval, and cancel cleanly.
11. Confirm links are keyboard-focusable with a visible focus ring in reading mode, inactive in Grid, and own taps/Pencil input without toggling chrome, selecting text, drawing ink, panning, or turning pages.

## Explicitly deferred to P6 and later

P5 deliberately does not implement destructive document-library/delete actions, PDF mutation, annotation embedding, print, multiple colors, erasing, undo/redo, or advanced ink tools. Annotated-copy export is now part of P6, while printing is still outstanding. The lazily loaded export chunk is available offline only after export has been used once online. Closing a tab is session management, not deletion; original OPFS PDF bytes are never modified.

## Validation

```bash
yarn tsc
yarn lint
yarn test --coverage
yarn build
```

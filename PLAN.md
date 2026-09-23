# ipad-mreader — Execution Plan

A clean-room reimplementation of the Windows 8.1 Reader app's reading experience for an iPad Air 5. Copy behavior only—never Microsoft code, assets, branding, or naming.

## Hard constraints

1. No Mac, Xcode, paid Apple account, App Store, or distribution. This is an installed PWA for personal use.
2. PDF only. XPS is out of scope.
3. TypeScript and Vite; rendering and gesture logic remain framework-agnostic.
4. The top priorities are the chromeless reading feel and semantic zoom.
5. Annotations are sidecar data and export only to a new PDF; original files are never mutated.
6. Files come from the iOS Files picker (including Dropbox). There is no managed library: the explicit ordered open-document session remains separate from P4's non-destructive recents list.
7. Horizontal, finger-following swipe is a mandatory page-turn interaction.

## Stack and architecture

- TypeScript, Vite, and an installed standalone PWA.
- `pdfjs-dist` core APIs for rendering, text, and outline data—not the bundled viewer.
- `pdf-lib` for a later “Save a copy” phase.
- Vanilla TypeScript for the viewer scene, layout, gestures, and renderer; Preact may later be used only for overlays.
- OPFS for PDF bytes and IndexedDB for sidecar state.
- Vitest for pure logic and Playwright WebKit as a regression net, never as a substitute for iPad testing.

The product architecture is one continuously zoomable scene. Page/spread and thumbnail-grid presentations are scale levels of the same scene, not unrelated modal viewers. During interaction, CSS transforms provide immediate feedback; rasterization happens after settling.

Native Safari zoom is suppressed with `touch-action: none` and non-passive prevention of WebKit gesture events. Navigation-swipe defense is layered: non-passive edge `touchstart`, a dummy history entry with `popstate` absorption, `overscroll-behavior-x: none`, and raw touch recognition.

## Phases

### P0 — device spike (complete)

Measure on the actual target iPad:

1. 500-page scanned and text-heavy PDF rendering, timing, responsiveness, and memory behavior.
2. Full ownership of pinch and pan without Safari page zoom.
3. OPFS write/read of a roughly 200 MB file, including quota and prompt behavior.
4. Standalone chrome removal and portrait/landscape safe areas.
5. Apple Pencil pressure, tilt, and perceived ink latency.
6. Finger-following page swipe from center and both edges, including navigation defense and any partial back-animation hitch.
7. `PointerEvent.getCoalescedEvents()` availability and sample counts.
8. Custom text hit-testing/selection while gesture ownership is active.

Items 1, 2, and 6 were kill/confirm gates and passed on the target iPad before product work began. The probe modules remain only as diagnostic references.

### P1 — reading core (complete, including physical sign-off)

OPFS and sidecar stores, PDF wrapper, pure single-page layout, camera/scene transforms, settled renderer, import, persisted reading position, pan/zoom, page turn, and page-width zoom.

### P2 — semantic zoom (complete, including physical sign-off)

Grid layout, worker-generated thumbnails, continuous threshold crossing during pinch, tap-to-jump, horizontal inertial scrolling, vertical/diagonal-vertical no-op, and rotation correction. The target-iPad pass and focused retest are complete; accepted grid-to-page smoothness polish is non-blocking.

### P3 — chrome (complete, including physical sign-off)

Deferred center-tap bars with double-tap disambiguation, explicit ordered open-document tabs, non-destructive session close, per-document restore, Page/Grid controls, and subtle bounded grid-end bounce. Default reading state remains page-only and bars-hidden. P2's physically approved horizontal momentum remains unchanged except for bounded end displacement and spring settle; legal focus/virtualization state never leaves its bounds. The complete installed-iPad checklist passed.

### P4 — layouts, Find, outline, and recents (implemented; focused device-patch retest pending)

- Safe-area-aware single, two-up, cover-aware two-up, and vertically continuous layouts with mixed-size page geometry, spread-aware turns, exact focused-page persistence, and bounded full-resolution continuous virtualization.
- Lifecycle-safe PDF text extraction, cancellable batched Find with progress/no-text reporting, result context, next/previous navigation, and non-interactive hit overlays.
- Lifecycle-safe nested outline retrieval and destination resolution, plus a non-destructive recents drawer that reopens documents into the explicit session. Missing OPFS files remain graceful; recents are not a managed library.
- Subtle focal-coherent double-tap return-to-fit animation with immediate reduced-motion behavior, and suppression of visually meaningless page-width zoom.
- Focused device patch: bounded pre-rasterized adjacent whole spreads with synchronous promotion, union-constrained spread zoom/pan, continuous release momentum, typing-safe shortcuts, owned panel scrolling, nested outline groups, fingerprint-aware Recents deduplication, and service-worker cache `mreader-p4-v2`.

### P5 — annotations

- Highlights, notes, custom selection handles, and an all-annotations index.
- Pressure-varying Pencil ink. Cut ink rather than the project if web latency is unacceptable.

P5 does not include document deletion/library management, save/export, or print. P4 deliberately provides no annotation, ink, text-selection, save, export, or print UI.

### P6 — export and print

Burn sidecar highlights, notes, and ink into a new PDF and send it through `navigator.share`; retain original bytes unchanged. Add browser printing.

### P7 — polish

Night mode, rotation, keyboard shortcuts, offline launch, production icons/manifest, and VoiceOver labels.

## Validation

Every phase ends with:

```bash
yarn tsc
yarn lint
yarn test --coverage
yarn build
```

Linux WebKit and desktop browsers cannot sign off feel-dependent device behavior.

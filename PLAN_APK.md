# mreader Android APK — Execution Plan

An Android build of the existing reader, packaged with Capacitor so that it can receive PDFs from other apps through **Open with** and **Share**. That ingress is the main reason for the app. The iPad PWA remains the primary product and its signed-off behavior must not change.

## Decisions

1. Distribution is a sideloaded debug APK (`adb install` or copying the file). No release signing or Play Store work.
2. The first target is a phone. Tablet support may come later, but nothing should rule it out.
3. **Open with** (`ACTION_VIEW`) and **Share** (`ACTION_SEND` / `ACTION_SEND_MULTIPLE`) for `application/pdf` are required.
4. The generated `android/` Gradle project is committed. Build outputs and local secrets are ignored.
5. Hardware back behaves like `Escape` while there is something to dismiss, then exits at the root.
6. If OPFS is missing or unreliable in Android System WebView, add a Capacitor Filesystem storage fallback behind the existing `src/store/opfs.ts` API.
7. App name `mreader`, application ID `org.schnip.mreader`.

## Constraints

1. The PWA build (`yarn build`) must remain behaviorally identical. Capacitor code must not enter its bundle; platform selection is a build-time constant, not runtime sniffing.
2. All existing hard invariants carry over: original PDF bytes are never mutated, sidecar/session/annotation stores remain separate v1 IndexedDB databases, closing a tab is not deletion, and the P4-v5 momentum and buffered-flick curves are not retuned.
3. Incoming files are copied into app storage through the normal importer. The source `content://` document is only read, never written or retained.
4. Dependencies use exact pinned versions. Use the current Capacitor major at install time and its documented JDK/SDK requirements (Capacitor 8: JDK 21, compile/target SDK 36).
5. The agent cannot run `yarn build`, and probably cannot run `cap add`, `cap sync`, or `gradlew`. Your excellency runs those. The agent keeps `yarn tsc`, `yarn lint`, and `yarn test --coverage` green.

## Prerequisites (host, one-time)

- JDK 21 and the Android SDK (platform 36, build-tools, platform-tools for `adb`), with `ANDROID_HOME` set.
- USB debugging enabled on the phone.

## Phases

### A1 — scaffolding and platform seam

1. Add pinned `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/app`, `@capacitor/filesystem`, `@capacitor/share`, and `@capacitor/app-launcher`.
2. Add `capacitor.config.ts`: `appId: "org.schnip.mreader"`, `appName: "mreader"`, `webDir: "dist"`, `android.androidScheme: "https"` (keeps a secure context for OPFS), background colour `#17191d`.
3. Run `cap add android` (your excellency). Set `launchMode="singleTask"` on the main activity so a second **Open with** reaches the running instance through `onNewIntent`. Add `android/app/build/`, `android/.gradle/`, `android/local.properties`, and keystore files to `.gitignore`.
4. Scripts:
   - `"build:android": "tsc && vite build --mode android"`
   - `"build-apk": "yarn build:android && cap sync android && cd android && ./gradlew assembleDebug"` — output `android/app/build/outputs/apk/debug/app-debug.apk`
   - `"install-apk": "adb install -r android/app/build/outputs/apk/debug/app-debug.apk"`
5. Add a `src/platform/` seam. `index.ts` re-exports `web.ts` or `native.ts` based on `import.meta.env.MODE === "android"`, so Vite eliminates the unused side. Move the current behavior into `web.ts` unchanged. The seam covers:
   - `registerServiceWorker()` — web: current code; native: no-op (assets are bundled and the service worker adds nothing).
   - `deliverExport(file)` — web: current share/download code; native: A3.
   - `openExternalUrl(url)` — web: current `window.open`; native: A3.
   - `installBackHandler(dismissForemost)` — web: current history defense; native: A3.
   - `installIngress(enqueue)` — web: `launchQueue` plus the share-target handoff; native: A2.
6. Replace the call sites in `reader.ts` (service worker, export delivery, external links, history defense, `launchQueue`/share target) with seam calls. No other reader changes.
7. Unit tests for both seam implementations, with Capacitor plugins mocked.

Done when: `yarn tsc`, `yarn lint`, and `yarn test --coverage` pass; the PWA bundle contains no Capacitor code; `yarn build-apk` produces an APK that launches, imports through **Open PDF**, renders, and restores after relaunch.

### A2 — Open with and Share ingress

1. `AndroidManifest.xml` intent filters on the main activity: `VIEW` (`content` and `file` schemes, `application/pdf`), `SEND` and `SEND_MULTIPLE` (`application/pdf`), all with `DEFAULT` and, for `VIEW`, `BROWSABLE` categories.
2. A small in-repo Capacitor plugin, `PdfIntentPlugin` (Java, under `android/app/src/main/java/org/schnip/mreader/`):
   - On `handleOnNewIntent` and on cold start, resolve every incoming URI, stream it with `ContentResolver.openInputStream` into `cacheDir/incoming/<uuid>.pdf`, and take the display name from `OpenableColumns.DISPLAY_NAME`. Never hold the whole file in memory and never pass bytes over the bridge.
   - Queue the results as `{ id, path, name }`. Expose `takePending()` so the JS side can drain the queue at startup (which avoids a race with listener registration), and emit a `pdfReceived` event for intents that arrive while running.
   - Expose `release({ id })` to delete a temporary copy. On startup, delete leftover temporary copies older than a day.
   - Report unreadable URIs as an error entry instead of throwing.
3. `native.ts` `installIngress`: drain `takePending()`, subscribe to `pdfReceived`, `fetch(Capacitor.convertFileSrc(path))` into a `File` with the original name, hand it to the existing `enqueuePdfImports`, then `release` it. Surface errors through the existing status message.
4. Tests for the JS side: cold-start drain, warm event, release after success and after failure, name fallback, and error reporting.

Done when (device): **Open with** from Files, Drive, and a mail attachment, plus **Share** from at least one app, both cold and while running, import the PDF into the session and make it current; a large (≥ 100 MB) PDF imports without crashing; temporary copies disappear afterwards.

### A3 — export, external links, and back

1. `deliverExport`: write the annotated copy to `Directory.Cache` with `@capacitor/filesystem` in base64 chunks (`writeFile`, then `appendFile`, with ~1 MiB chunks) to bound bridge memory; share the resulting URI with `@capacitor/share`; delete the cached copy afterwards. Treat share cancellation the same way the web path treats `AbortError`.
2. `openExternalUrl`: after the existing confirmation dialog, open with `@capacitor/app-launcher` so web, `mailto:`, and `tel:` links reach the system handler. Only the already-validated safe protocols reach this call.
3. `installBackHandler`: listen to `App.addListener("backButton")`. Dismiss in this order: note editor, open panel (Find, More, Outline, Recents, Annotations), text selection, visible chrome, thumbnail grid (return to the focused page). When nothing is left, call `App.exitApp()`. Do not install the web history defense in native builds.
4. Tests for chunked writing, cleanup on success/cancel/failure, the back-dismissal order, and exit at root.

Done when (device): export opens the Android share sheet and the shared copy opens correctly elsewhere; cancellation is clean; links open externally only after confirmation; back follows the order above and exits at root.

### A4 — icons and splash

1. Generate launcher icons (legacy and adaptive foreground/background) and a plain `#17191d` splash from `public/icon.svg`. Use `@capacitor/assets` if it accepts the SVG source; otherwise your excellency exports PNGs (ImageMagick is blocked by the agent policy).
2. Do not change the PWA manifest icons in this plan.

### A5 — storage fallback (conditional)

Only if the A1 device check shows `navigator.storage.getDirectory()` missing or failing in the phone's WebView:

1. Add a Filesystem-backed implementation behind the same exports as `src/store/opfs.ts` (`Directory.Data`, app-private), selected at build time for Android.
2. Large reads must avoid base64 round trips where possible; read through `Capacitor.convertFileSrc` + `fetch`.
3. Tests mirroring the existing OPFS store contract.

### A6 — phone device check

Add an "Android device checklist" section to the README, then verify on the phone:

1. Launch, import through each path, relaunch restoration of the session, document, page, and camera.
2. OPFS availability and quota (decides A5).
3. Safe areas in portrait and landscape, including the status bar and gesture navigation area (Android WebView has historically reported zero `env(safe-area-inset-*)`; if so, the native layer must supply insets).
4. Swipe page turns, pinch into and out of the grid, page-width double-tap, center/edge taps, Continuous scrolling — with no native WebView zoom, overscroll glow, or system back gesture stealing edge swipes.
5. Layout suitability on a phone: Single and Continuous are expected to be the useful modes; record whether two-page modes and grid density need phone-specific defaults. Any tuning is a separate follow-up and must not change iPad behavior.
6. Text selection, highlights, notes with the soft keyboard, annotation index, and export.
7. External links, back-button order, and exit.
8. A large document under memory pressure, and backgrounding/resuming the app.
9. Stylus input only if a stylus device becomes available (tablet follow-up).

## Execution order

A1 must land first because every later phase depends on the seam. After it, A2 and A3 are independent and can run in parallel. A4 can run at any time. A5 runs only if A6's storage check requires it. A6 is your excellency's on-device pass, repeated after each phase as needed.

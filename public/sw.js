// Build number and precache list are injected by the `mreader-service-worker`
// Vite plugin. The literal placeholders remain during `vite dev`.
const BUILD = "__MREADER_BUILD__";
const BUILD_ASSETS = [/* __MREADER_PRECACHE__ */];
const CACHE_PREFIX = "mreader-";
const CACHE = `${CACHE_PREFIX}p6-${BUILD}`;
const SHARE_CACHE = `${CACHE_PREFIX}shares-v1`;
const CORE = ["./", "./manifest.webmanifest", "./icon.svg"];
const NAVIGATION_TIMEOUT_MS = 4000;
const SCOPE = new URL(self.registration.scope);
const SHARE_TARGET = new URL("./share-target", SCOPE);
const SHARED_PDF_PREFIX = new URL("./__mreader_shared_pdf__/", SCOPE);
const ASSETS_PREFIX = new URL("./assets/", SCOPE);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...CORE, ...BUILD_ASSETS.map((asset) => `./${asset}`)])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(removeStaleCaches().then(() => self.clients.claim()));
});

/**
 * Only this app's caches are touched; other apps on the same origin keep
 * theirs. The newest previous build cache is retained so a window that is
 * still running the previous build can lazily load its own hashed chunks
 * (for example the export chunk) until it is relaunched.
 */
async function removeStaleCaches() {
  const builds = (await caches.keys())
    .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE && key !== SHARE_CACHE)
    .sort()
    .reverse();
  const retainedPrevious = builds.find((key) => key.startsWith(`${CACHE_PREFIX}p6-`) && key < CACHE);
  await Promise.all(builds.filter((key) => key !== retainedPrevious).map((key) => caches.delete(key)));
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === SHARE_TARGET.pathname) {
    event.respondWith(receiveSharedPdf(event.request));
    return;
  }
  if (event.request.method === "GET" && url.pathname.startsWith(SHARED_PDF_PREFIX.pathname)) {
    event.respondWith(takeSharedPdf(event.request));
    return;
  }
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(navigate(event));
    return;
  }
  if (url.pathname.startsWith(ASSETS_PREFIX.pathname)) {
    // Hashed build output never changes under the same URL.
    event.respondWith(cacheFirst(event));
    return;
  }
  // Unhashed files such as the manifest and icon must pick up redeploys.
  event.respondWith(networkFirst(event, event.request));
});

async function navigate(event) {
  // Every navigation, including `?mreader-share=` launches, shares one entry.
  const key = new URL("./", SCOPE).href;
  return networkFirst(event, key, NAVIGATION_TIMEOUT_MS);
}

async function networkFirst(event, key, timeoutMs) {
  try {
    const response = await withTimeout(fetch(event.request), timeoutMs);
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(key, copy)));
    }
    return response;
  } catch (error) {
    const cached = await caches.match(key);
    if (cached) return cached;
    if (event.request.mode === "navigate") {
      const shell = await caches.match(new URL("./", SCOPE).href);
      if (shell) return shell;
    }
    throw error;
  }
}

async function cacheFirst(event) {
  const cached = await caches.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (response.ok) {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
  }
  return response;
}

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Network timed out.")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function receiveSharedPdf(request) {
  try {
    const formData = await request.formData();
    const pdf = formData.get("pdf");
    const validPdf = pdf instanceof File
      && pdf.size > 0
      && (pdf.type === "application/pdf" || pdf.name.toLowerCase().endsWith(".pdf"));
    if (!validPdf) return Response.redirect(new URL("./?mreader-share-error=pdf", SCOPE), 303);
    const id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("");
    const sharedUrl = new URL(`./__mreader_shared_pdf__/${id}`, SCOPE);
    const cache = await caches.open(SHARE_CACHE);
    await Promise.all((await cache.keys()).map((key) => cache.delete(key)));
    await cache.put(sharedUrl, new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "X-Mreader-Filename": encodeURIComponent(pdf.name || "shared.pdf")
      }
    }));
    return Response.redirect(new URL(`./?mreader-share=${encodeURIComponent(id)}`, SCOPE), 303);
  } catch (error) {
    console.warn("Unable to receive a shared PDF", error);
    return Response.redirect(new URL("./?mreader-share-error=pdf", SCOPE), 303);
  }
}

async function takeSharedPdf(request) {
  const cache = await caches.open(SHARE_CACHE);
  const response = await cache.match(request);
  if (!response) return new Response("Shared PDF not found", { status: 404 });
  await cache.delete(request);
  return response;
}

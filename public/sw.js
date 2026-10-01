const CACHE = "mreader-p6-v1";
const SHARE_CACHE = "mreader-shares-v1";
const CORE = ["./", "./manifest.webmanifest", "./icon.svg"];
const SHARE_TARGET = new URL("./share-target", self.registration.scope);
const SHARED_PDF_PREFIX = new URL("./__mreader_shared_pdf__/", self.registration.scope);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== SHARE_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

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
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match(event.request).then((cached) => cached ?? caches.match("./")))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request).then((response) => {
      if (response.ok && new URL(event.request.url).origin === self.location.origin) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});

async function receiveSharedPdf(request) {
  const formData = await request.formData();
  const pdf = formData.get("pdf");
  const validPdf = pdf instanceof File
    && pdf.size > 0
    && (pdf.type === "application/pdf" || pdf.name.toLowerCase().endsWith(".pdf"));
  if (!validPdf) return Response.redirect(new URL("./?mreader-share-error=pdf", self.registration.scope), 303);
  const id = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("");
  const sharedUrl = new URL(`./__mreader_shared_pdf__/${id}`, self.registration.scope);
  const cache = await caches.open(SHARE_CACHE);
  await Promise.all((await cache.keys()).map((key) => cache.delete(key)));
  await cache.put(sharedUrl, new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "X-Mreader-Filename": encodeURIComponent(pdf.name || "shared.pdf")
    }
  }));
  return Response.redirect(new URL(`./?mreader-share=${encodeURIComponent(id)}`, self.registration.scope), 303);
}

async function takeSharedPdf(request) {
  const cache = await caches.open(SHARE_CACHE);
  const response = await cache.match(request);
  if (!response) return new Response("Shared PDF not found", { status: 404 });
  await cache.delete(request);
  return response;
}

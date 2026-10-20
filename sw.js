const CACHE = "qingruxu-v36.8";
const FILES = ["./", "./index.html", "./styles.css?v=36.8", "./upgrades.css?v=36.8", "./online-source.js?v=36.8", "./library-storage.js?v=36.8", "./app-upgrades.js?v=36.8", "./app.js?v=36.8", "./manifest.webmanifest?v=36.8", "./assets/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("qingruxu-") && key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith('/qrx-api/')) return;
  if (event.request.mode === "navigate" && new URL(event.request.url).origin === self.location.origin) {
    event.respondWith(fetch(event.request).then(async (response) => {
      if (response.ok) await (await caches.open(CACHE)).put('./index.html', response.clone());
      return response;
    }).catch(async () => (await caches.match('./index.html')) || Response.error()));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

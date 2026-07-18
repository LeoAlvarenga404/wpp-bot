// Minimal service worker: network-passthrough only. Exists to satisfy the
// PWA installability heuristics on older Chrome/Android versions — the panel
// is an online tool (the approval API is the whole point), so no offline
// caching is attempted.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

/* PAL Data Sorter — service worker.
   Shell is stale-while-revalidate (instant loads, updates in the background);
   navigations are network-first (fresh HTML online, cached shell offline);
   /api/snapshot is network-first with a cached fallback so the app still opens
   and shows the last-seen standings with no connection. Bump VERSION to force
   a clean re-cache on a breaking change. */
const VERSION = 'v1';
const SHELL_CACHE = 'pal-shell-' + VERSION;
const DATA_CACHE = 'pal-data-' + VERSION;

const SHELL = [
  '/', '/index.html', '/app.js', '/styles.css', '/favicon.svg',
  '/manifest.webmanifest',
  '/icon-192.png', '/icon-512.png',
  '/icon-maskable-192.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // never intercept POST /api/refresh
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // let cross-origin (fonts) pass through

  // App data: network-first, fall back to the last cached snapshot when offline.
  if (url.pathname === '/api/snapshot') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(DATA_CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) return;        // other API calls: straight to network

  // Navigations: network-first so a new deploy's HTML wins; cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put('/', copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('/index.html') || caches.match('/')))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

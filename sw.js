// Network-first service worker: always fresh when online (so pushed updates
// show up on next launch), falls back to cache when offline.
// Another hub shares this origin (kunertgraf.github.io), so only ever touch caches with our prefix.
const CACHE_PREFIX = 'playroom-';
const CACHE = CACHE_PREFIX + 'v1';
const NETWORK_TIMEOUT_MS = 3000;

const SHELL = [
  './',
  'index.html',
  'hub.css',
  'hub.js',
  'apps.json',
  'manifest.webmanifest',
  'shared/base.css',
  'shared/store.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map(fresh))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The hub sends the list of app files to cache ahead of time.
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'precache') return;
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(e.data.urls.map((u) => c.add(fresh(u)).catch(() => console.warn('precache failed', u)))),
    ),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  e.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    let response = await withTimeout(fetch(fresh(request.url)), NETWORK_TIMEOUT_MS);
    // Safari refuses redirected responses for page loads; let the browser follow it itself.
    if (response.redirected) response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw new Error(`Offline and not cached: ${request.url}`);
  }
}

// GitHub Pages sends max-age=600, so a plain fetch can return a 10-minute-old copy from the
// browser's HTTP cache. 'no-cache' always revalidates (a cheap 304 when nothing changed).
function fresh(url) {
  return new Request(new URL(url, self.location).href, { cache: 'no-cache', credentials: 'same-origin' });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

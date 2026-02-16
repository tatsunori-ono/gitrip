const CACHE_VERSION = 'gitrip-offline-v1';
const CORE_ASSETS = [
  '/',
  '/public/style.css',
  '/public/css/app.css',
  '/public/logo.svg',
  '/public/favicon.svg',
  '/public/explore.css',
  '/public/explore.js',
  '/public/js/ui.js',
  '/public/offline.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_VERSION)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/public/offline.html'));
    return;
  }

  if (url.pathname.startsWith('/public/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Only cache safe, public API endpoints — skip sensitive endpoints
  // (user data, trip plans, checklists, etc.) to avoid leaking private data
  if (url.pathname.startsWith('/api/geo/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Don't cache other /api/ routes (private trip data, auth, etc.)
  if (url.pathname.startsWith('/api/')) {
    return; // let the browser handle normally (no caching)
  }

  event.respondWith(networkFirst(request));
});

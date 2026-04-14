// Bump this version string on any SW logic change to force clients to
// re-install. The activate handler deletes old caches aggressively.
// v5 = fix /api/* fetch handler (was returning Promise<undefined> on
//      network error — "Returned response is null" in Safari). Now
//      just bails out of the handler for /api/* and lets the browser
//      handle those requests natively.
const CACHE_VERSION = 'v5';
const CACHE_NAME = `flarestat-${CACHE_VERSION}`;
const OFFLINE_FALLBACK = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([OFFLINE_FALLBACK, '/manifest.json']),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Don't intercept /api/* at all. POSTs already bail out via the
  // GET-only check above; the rare GET cases (direct /api/health
  // navigation, curl tests) don't benefit from SW caching and the
  // old network-first-with-cache-fallback logic was buggy (returned
  // Promise<undefined> which Safari reports as "Returned response
  // is null"). Let the browser handle these directly.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Network-first for HTML navigation requests so deploys go live immediately.
  // Never serve a stale HTML document — it references hashed JS bundles that
  // may no longer exist on the server after a deploy.
  const isNav =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');
  if (isNav) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(async () => (await caches.match(request)) || offline()),
    );
    return;
  }

  // Cache-first for hashed static assets (JS/CSS/images/fonts). Hashed
  // filenames mean new deploys get new URLs, so cache-first is safe.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && url.origin === location.origin) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        }),
    ),
  );
});

async function offline() {
  return (
    (await caches.match(OFFLINE_FALLBACK)) ||
    new Response('Offline', { status: 503 })
  );
}

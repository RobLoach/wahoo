// Wahoo service worker: offline support for local (hot-seat/CPU) play.
// Hashed build assets are cached forever; navigations are network-first so a
// new deploy is picked up on the next online visit.
const CACHE = 'wahoo-v6'; // bumped: v5 entries were stored with Vary intact

/**
 * Store a response with its Vary header stripped, keyed by plain URL.
 * Chromium silently ignores `ignoreVary`, so a precached entry (fetched by
 * this worker without an Origin header) would never match the page's CORS
 * requests while the server sends `Vary: Origin` — which broke the first
 * offline launch whenever precache won the race against runtime caching.
 */
async function putClean(cache, key, res) {
  if (!res || !res.ok) return;
  const headers = new Headers(res.headers);
  headers.delete('vary');
  const body = await res.clone().blob();
  await cache.put(key, new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  }));
}

const fetchInto = (cache, url) =>
  fetch(url).then(res => putClean(cache, url, res)).catch(() => {});

self.addEventListener('install', event => {
  // Precache the app shell so even a first visit survives going offline.
  event.waitUntil(
    caches.open(CACHE).then(c => fetchInto(c, self.registration.scope)),
  );
  self.skipWaiting();
});

// The page reports the assets it already loaded (they were fetched before
// this worker took control, so the fetch handler never saw them).
self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg || msg.t !== 'precache' || !Array.isArray(msg.urls)) return;
  const urls = msg.urls
    .filter(u => typeof u === 'string' && u.startsWith(self.location.origin))
    .slice(0, 200);
  event.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(
        urls.map(u => c.match(u).then(hit => (hit ? null : fetchInto(c, u)))),
      ),
    ),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Look the URL up again, straight in the named cache, with one delayed
 * retry. At service-worker cold start `caches.match` can transiently miss
 * entries that exist (the offline navigation's first burst of subresource
 * requests races the cache index) — this rescues those.
 */
async function stubbornMatch(url) {
  for (const wait of [0, 100, 200, 400, 800]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    const c = await caches.open(CACHE);
    const hit = await c.match(url).catch(() => undefined);
    if (hit) return hit;
  }
  return undefined;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then(c => putClean(c, req.url, copy)));
          return res;
        })
        .catch(async () =>
          (await stubbornMatch(req.url)) ?? (await stubbornMatch(self.registration.scope)),
        ),
    );
    return;
  }

  // Assets: cache-first, keyed by URL so request headers can't affect the
  // lookup; fill the cache on the way through. When the network is also
  // down, insist on the cache before failing.
  event.respondWith(
    (async () => {
      const hit = await caches.match(req.url).catch(() => undefined);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then(c => putClean(c, req.url, copy)));
        return res;
      } catch (err) {
        const rescued = await stubbornMatch(req.url);
        if (rescued) return rescued;
        throw err;
      }
    })(),
  );
});

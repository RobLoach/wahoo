// Wahoo service worker: offline support for local (hot-seat/CPU) play.
// Hashed build assets are cached forever; navigations are network-first so a
// new deploy is picked up on the next online visit.
const CACHE = 'wahoo-v5'; // bumped for the tabletop redesign: purge old-theme assets

self.addEventListener('install', event => {
  // Precache the app shell so even a first visit survives going offline.
  event.waitUntil(
    caches.open(CACHE).then(c => c.add(self.registration.scope)).catch(() => {}),
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
        urls.map(u => c.match(u, { ignoreVary: true }).then(hit => (hit ? null : c.add(u).catch(() => {})))),
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
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreVary: true }).then(hit => hit || caches.match(self.registration.scope, { ignoreVary: true })),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreVary: true }).then(
      hit =>
        hit ||
        fetch(req).then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

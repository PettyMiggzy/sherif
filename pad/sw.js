// Robin Labs service worker.
// Purpose: make the site an installable, store-packageable PWA (PWABuilder / Bubblewrap
// need a fetch handler) and show a friendly offline page. It is deliberately conservative:
// NETWORK-FIRST so a dApp is never served stale code, and it NEVER touches API, wallet,
// or cross-origin traffic (no caching of signing requests, RPC, DexScreener, etc.).
const CACHE = 'robinlabs-v1';
const PRECACHE = ['/offline.html', '/assets/icon-192.png', '/assets/favicon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // never intercept POST / signing traffic
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // API, wallet, RPC, DexScreener go straight to network
  // Network-first: always try fresh (a dApp must not go stale). Cache only successful same-origin GETs
  // as an OFFLINE fallback; on a failed navigation, show the offline page.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/offline.html') : Response.error())))
  );
});

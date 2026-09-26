// robinlab.io used to be a static site that registered a service worker here
// (network-first, with an offline copy of its pages). This is its retirement:
// browsers fetch /sw.js on their next visit, install this version, and it
// deletes the old caches and unregisters itself, so nobody is ever served a
// cached page from the old site.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});

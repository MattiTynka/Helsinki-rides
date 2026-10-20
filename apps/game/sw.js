// Pages service worker: cache-first for immutable, content-addressed files only, namely the pinned world release
// directory and the hashed application assets named by `immutable` query parameters. The page, the Basis decoders
// and everything else go to the network as before. A new world release installs a new worker that deletes old caches.
const params = new URL(self.location.href).searchParams;
const prefixes = params.getAll('immutable');
const CACHE = `helsinki-rides:${params.get('id') ?? 'none'}`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('helsinki-rides:') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range') || !prefixes.some(prefix => request.url.startsWith(prefix))) return;
  event.respondWith(cacheFirst(request, event));
});

async function cacheFirst(request, event) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Only complete same-origin or CORS responses; a full quota simply leaves the file uncached.
  if (response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
    event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
  }
  return response;
}

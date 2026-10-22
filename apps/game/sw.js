// Immutable downloads are a bounded LRU convenience. Travelling across the complete map must not retain it on disk.
const params = new URL(self.location.href).searchParams;
const prefixes = params.getAll('immutable');
const CACHE = `helsinki-rides:bounded-v2:${params.get('id') ?? 'none'}`;
const MAX_BYTES = 96 * 1024 * 1024, MAX_ENTRIES = 128, MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const INDEX = new URL('__helsinki-cache-index__', self.registration.scope).href;
let state, serial = Promise.resolve(), pendingCopies = 0;
const allowed = url => prefixes.some(prefix => url.startsWith(prefix));

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('helsinki-rides:') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range') || !allowed(request.url)) return;
  event.respondWith(cacheFirst(request, event));
});

// All accounting and cache mutations serialize; simultaneous district downloads cannot each spend the budget.
function update(job) {
  const pending = serial.then(job);
  serial = pending.catch(() => {});
  return pending;
}
async function index(cache) {
  if (state) return state;
  let saved;
  try { saved = await (await cache.match(INDEX))?.json(); } catch { /* An incomplete prior write is disposable. */ }
  const entries = new Map();
  if (Array.isArray(saved?.entries) && saved.entries.length <= MAX_ENTRIES) for (const item of saved.entries) {
    if (typeof item.url === 'string' && allowed(item.url) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= MAX_ENTRY_BYTES
      && Number.isSafeInteger(item.used) && item.used >= 0) entries.set(item.url, item);
  }
  // A worker may terminate between payload/index writes. Remove orphaned records rather than trusting an underestimate.
  const present = new Set();
  for (const request of await cache.keys()) {
    if (request.url === INDEX) continue;
    if (!entries.has(request.url)) await cache.delete(request);
    else present.add(request.url);
  }
  for (const url of entries.keys()) if (!present.has(url)) entries.delete(url);
  state = { entries, clock: Math.max(0, ...[...entries.values()].map(item => item.used)) };
  await trim(cache, 0, 0);
  return state;
}
async function save(cache) {
  await cache.put(INDEX, new Response(JSON.stringify({ entries: [...state.entries.values()] }), { headers: { 'Content-Type': 'application/json' } }));
}
async function trim(cache, incomingBytes, incomingEntries) {
  let bytes = [...state.entries.values()].reduce((sum, item) => sum + item.bytes, 0);
  const oldest = [...state.entries.values()].sort((a, b) => a.used - b.used);
  while (bytes + incomingBytes > MAX_BYTES || state.entries.size + incomingEntries > MAX_ENTRIES) {
    const item = oldest.shift();
    if (!item) break;
    await cache.delete(item.url); state.entries.delete(item.url); bytes -= item.bytes;
  }
}
async function boundedCopy(response) {
  if (!response.body) return null;
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_ENTRY_BYTES) { void response.body.cancel().catch(() => {}); return null; }
  const reader = response.body.getReader(), parts = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_ENTRY_BYTES) { void reader.cancel().catch(() => {}); return null; }
      parts.push(item.value);
    }
  } finally { reader.releaseLock(); }
  if (!bytes) return null;
  // Count actual decoded response bytes: compressed Content-Length can be much smaller on static hosts.
  return { bytes, response: new Response(new Blob(parts), { status: response.status, statusText: response.statusText, headers: response.headers }) };
}
async function cacheFirst(request, event) {
  let cache, hit;
  try { cache = await caches.open(CACHE); await update(() => index(cache)); hit = await cache.match(request); }
  catch { return fetch(request); }
  if (hit) {
    event.waitUntil(update(async () => {
      const item = state.entries.get(request.url);
      if (item) { item.used = ++state.clock; await save(cache); }
    }).catch(() => {}));
    return hit;
  }
  const response = await fetch(request);
  // Copy at most two responses at once. Cache failure never blocks playing.
  if (response.status === 200 && (response.type === 'basic' || response.type === 'cors') && pendingCopies < 2) {
    pendingCopies++;
    const copy = response.clone();
    event.waitUntil((async () => {
      const payload = await boundedCopy(copy);
      if (!payload) return;
      await update(async () => {
        await cache.delete(request); state.entries.delete(request.url);
        await trim(cache, payload.bytes, 1);
        await cache.put(request, payload.response);
        state.entries.set(request.url, { url: request.url, bytes: payload.bytes, used: ++state.clock });
        await save(cache);
      });
    })().catch(() => {}).finally(() => { pendingCopies--; }));
  }
  return response;
}

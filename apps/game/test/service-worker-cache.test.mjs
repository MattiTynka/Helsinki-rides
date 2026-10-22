import assert from 'node:assert/strict';
import test from 'node:test';
let fixtureId = 0;
async function worker(options = {}) {
    const handlers = new Map(), stores = new Map(), requests = [], prefix = 'https://example.com/game/world/release/', index = 'https://example.com/game/__helsinki-cache-index__';
    const url = request => typeof request === 'string' ? request : request.url;
    const makeCache = () => {
        const records = new Map();
        return { records, async match(request) {
                if (options.payloadMatchFails && url(request) !== index)
                    throw new Error('cache backend closed after index read');
                return records.get(url(request))?.clone();
            }, async put(request, response) {
                records.set(url(request), response.clone());
            }, async delete(request) {
                return records.delete(url(request));
            }, async keys() {
                return [...records.keys()].map(value => new Request(value));
            } };
    };
    const previous = { self: globalThis.self, caches: globalThis.caches, fetch: globalThis.fetch };
    globalThis.self = { location: { href: `https://example.com/game/sw.js?id=fixture-${++fixtureId}&immutable=${encodeURIComponent(prefix)}` }, registration: { scope: 'https://example.com/game/' }, skipWaiting() {
        }, clients: { async claim() {
            } }, addEventListener(name, handler) {
            handlers.set(name, handler);
        } };
    globalThis.caches = { async open(name) {
            if (options.unavailable)
                throw new Error('storage unavailable');
            if (!stores.has(name))
                stores.set(name, makeCache());
            return stores.get(name);
        }, async keys() {
            return [...stores.keys()];
        }, async delete(name) {
            return stores.delete(name);
        } };
    globalThis.fetch = async (request) => {
        requests.push(url(request));
        const response = options.response ? await options.response(request) : new Response(`payload:${url(request)}`);
        Object.defineProperty(response, 'type', { value: 'basic' });
        return response;
    };
    await import(`../sw.js?test=${fixtureId}`);
    const request = async (name, { method = 'GET', range = false, drain = true } = {}) => {
        const waits = [];
        let result;
        const event = { request: new Request(name.startsWith('https:') ? name : prefix + name, { method, headers: range ? { Range: 'bytes=0-3' } : {} }), respondWith(p) {
                result = p;
            }, waitUntil(p) {
                waits.push(p);
            } };
        handlers.get('fetch')(event);
        if (!result)
            return null;
        const response = await result;
        if (drain)
            await Promise.all(waits);
        return { response, waits };
    };
    return { request, requests, stores, index, prefix, async metadata() {
            const store = [...stores.values()][0];
            return (await store?.match(index))?.json();
        }, restore() {
            globalThis.self = previous.self;
            globalThis.caches = previous.caches;
            globalThis.fetch = previous.fetch;
        } };
}
test('immutable disk cache retains at most128 payloads and evicts least recently used downloads', async () => {
    const f = await worker();
    try {
        for (let i = 0; i < 128; i++)
            await f.request(`cell-${i}`);
        await f.request('cell-0');
        await f.request('cell-128');
        const entries = (await f.metadata()).entries;
        assert.equal(entries.length, 128);
        assert.ok(entries.some(e => e.url.endsWith('/cell-0')));
        assert.ok(!entries.some(e => e.url.endsWith('/cell-1')));
        const count = f.requests.length;
        await f.request('cell-0');
        assert.equal(f.requests.length, count);
        await f.request('cell-1');
        assert.equal(f.requests.length, count + 1);
    }
    finally {
        f.restore();
    }
});
test('cache byte accounting uses actual response bytes and evicts before exceeding96MiB', async () => {
    const size = 25 * 1024 * 1024, f = await worker({ response: () => new Response(new Blob([new Uint8Array(size)]), { headers: { 'Content-Length': '1', 'Content-Encoding': 'gzip' } }) });
    try {
        for (let i = 0; i < 4; i++)
            await f.request(`large-${i}`);
        const entries = (await f.metadata()).entries;
        assert.equal(entries.length, 3);
        assert.equal(entries.reduce((sum, e) => sum + e.bytes, 0), size * 3);
        assert.ok(!entries.some(e => e.url.endsWith('/large-0')));
        assert.ok(entries.every(e => e.bytes === size));
    }
    finally {
        f.restore();
    }
});
test('oversized responses remain playable without consuming cache budget', async () => {
    const size = 33 * 1024 * 1024, f = await worker({ response: () => new Response(new Blob([new Uint8Array(size)]), { headers: { 'Content-Length': String(size) } }) });
    try {
        const result = await f.request('oversized');
        assert.equal((await result.response.arrayBuffer()).byteLength, size);
        assert.equal((await f.metadata())?.entries?.length ?? 0, 0);
    }
    finally {
        f.restore();
    }
});
test('only two response copies can be pending and unrelated/range/state-changing requests bypass worker', async () => {
    let release;
    const gate = new Promise(resolve => release = resolve), f = await worker({ response: () => new Response(new ReadableStream({ async start(controller) {
                await gate;
                controller.enqueue(Uint8Array.of(1, 2, 3));
                controller.close();
            } })) });
    try {
        assert.equal(await f.request('https://elsewhere.example/model.glb'), null);
        assert.equal(await f.request('cell-range', { range: true }), null);
        assert.equal(await f.request('cell-post', { method: 'POST' }), null);
        const pending = await Promise.all([0, 1, 2, 3].map(i => f.request(`simultaneous-${i}`, { drain: false })));
        assert.equal(f.requests.length, 4);
        release();
        await Promise.all(pending.flatMap(p => p.waits));
        assert.equal((await f.metadata()).entries.length, 2);
    }
    finally {
        release();
        f.restore();
    }
});
test('denied browser cache access falls back to network instead of failing world loading', async () => {
    const f = await worker({ unavailable: true });
    try {
        const result = await f.request('cell');
        assert.match(await result.response.text(), /payload:/);
        assert.equal(f.requests.length, 1);
    }
    finally {
        f.restore();
    }
});
test('a cache payload read failure after successful index initialization still reaches the network', async () => {
    const f = await worker({ payloadMatchFails: true });
    try {
        const result = await f.request('cell');
        assert.match(await result.response.text(), /payload:/);
        assert.equal(f.requests.length, 1);
    }
    finally {
        f.restore();
    }
});

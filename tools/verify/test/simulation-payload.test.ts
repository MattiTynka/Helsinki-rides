import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchSimulationPayload } from '../../../apps/game/src/world/payload.ts';
import { readSimulationPayload } from '../lib/simulation-payload.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const original = new Uint8Array(10000).map((_, i) => i % 255), stored = gzipSync(original);
const ref = { path: 'collision.hcol.gz', bytes: stored.length, sha256: sha(stored), compression: 'gzip' as const, decodedBytes: original.length, decodedSha256: sha(original) };

test('browser streamed delivery and Node replay decode the same pinned simulation bytes', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(stored));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'helsinki-payload-'));
  try {
    writeFileSync(path.join(directory, ref.path), stored);
    assert.deepEqual(await fetchSimulationPayload('https://example.com/' + ref.path, ref), original);
    assert.deepEqual(await readSimulationPayload(directory, ref), original);
  } finally { rmSync(directory, { recursive: true }); }
});

test('browser fetch stops and cancels an oversized stored payload', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(ref.bytes + 1)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(fetchSimulationPayload('https://example.com/' + ref.path, ref), /exceeds its declared size/);
  assert.equal(cancelled, true);
});

test('browser rejects incomplete delivery before decoding', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(stored.subarray(0, stored.length - 1)));
  await assert.rejects(fetchSimulationPayload('https://example.com/' + ref.path, ref), /byte length mismatch/);
});

test('HTTP gzip decoding exposes the original bytes while browser and Node replay still agree exactly', async t => {
  // Fetch transparently decodes Content-Encoding, but its headers still describe the compressed response.
  t.mock.method(globalThis, 'fetch', async () => new Response(original, {
    headers: { 'Content-Encoding': 'gzip', 'Content-Length': String(stored.length) },
  }));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'helsinki-http-gzip-'));
  try {
    writeFileSync(path.join(directory, ref.path), stored);
    const browser = await fetchSimulationPayload('https://example.com/' + ref.path, ref);
    const replay = await readSimulationPayload(directory, ref);
    assert.deepEqual(browser, original);
    assert.deepEqual(browser, replay);
  } finally { rmSync(directory, { recursive: true }); }
});

test('an HTTP gzip wrapper can leave the pinned compressed file exposed after transport decoding', async t => {
  // A server may gzip the already-compressed .gz file again. Fetch removes only that transport wrapper.
  t.mock.method(globalThis, 'fetch', async () => new Response(stored, { headers: { 'Content-Encoding': 'gzip' } }));
  assert.deepEqual(await fetchSimulationPayload('https://example.com/' + ref.path, ref), original);
});

test('HTTP decoded delivery still rejects a wrong decoded digest and same-length corrupt bytes', async t => {
  let exposed = original;
  t.mock.method(globalThis, 'fetch', async () => new Response(exposed, { headers: { 'Content-Encoding': 'gzip' } }));
  await assert.rejects(fetchSimulationPayload('https://example.com/' + ref.path, { ...ref, decodedSha256: '0'.repeat(64) }), /SHA-256 mismatch/);
  exposed = new Uint8Array(original); exposed[100] = exposed[100]! ^ 1;
  await assert.rejects(fetchSimulationPayload('https://example.com/' + ref.path, ref), /SHA-256 mismatch/);
});

test('HTTP decoded delivery rejects a truncated original payload', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(original.subarray(0, original.length - 1), { headers: { 'Content-Encoding': 'gzip' } }));
  await assert.rejects(fetchSimulationPayload('https://example.com/' + ref.path, ref), /byte length mismatch/);
});

test('HTTP decoded delivery cancels a response exceeding the decoded size bound', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(ref.decodedBytes + 1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Encoding': 'gzip' } }));
  await assert.rejects(fetchSimulationPayload('https://example.com/' + ref.path, ref), /exceeds its declared size/);
  assert.equal(cancelled, true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { decodeSimulationPayload, MAX_SIMULATION_PAYLOAD_BYTES, validateSimulationFileRef, type SimulationFileRef } from '../src/index.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const original = new Uint8Array(180000).map((_, i) => (i * 5) % 37);
const stored = gzipSync(original);
const ref: SimulationFileRef = { path: 'cells/test.hcol.gz', bytes: stored.length, sha256: sha(stored), compression: 'gzip', decodedBytes: original.length, decodedSha256: sha(original) };

test('gzip simulation delivery reproduces every original byte', async () => {
  assert.deepEqual(validateSimulationFileRef(ref), []);
  assert.deepEqual(await decodeSimulationPayload(stored, ref), original);
});

test('old uncompressed references remain compatible and preserve the input allocation', async () => {
  const raw = { path: 'terrain.bin', bytes: original.length, sha256: sha(original) };
  assert.equal(await decodeSimulationPayload(original, raw), original);
});

test('stored and decoded digest checks each reject corruption', async () => {
  const corrupt = new Uint8Array(stored); corrupt[20] = corrupt[20]! ^ 1;
  await assert.rejects(decodeSimulationPayload(corrupt, ref), /SHA-256 mismatch/);
  await assert.rejects(decodeSimulationPayload(stored, { ...ref, decodedSha256: '0'.repeat(64) }), /SHA-256 mismatch/);
});

test('decoder bounds output by the declared size and rejects truncated or excessive streams', async () => {
  await assert.rejects(decodeSimulationPayload(stored, { ...ref, decodedBytes: 1024 }), /exceeds its declared size/);
  await assert.rejects(decodeSimulationPayload(stored, { ...ref, decodedBytes: original.length + 1 }), /byte length mismatch/);
  const truncated = stored.subarray(0, stored.length - 8);
  await assert.rejects(decodeSimulationPayload(truncated, { ...ref, bytes: truncated.length, sha256: sha(truncated) }));
});

test('manifest claims cannot raise fixed storage or decoded limits and metadata is all or nothing', () => {
  for (const patch of [
    { bytes: MAX_SIMULATION_PAYLOAD_BYTES + 1 }, { decodedBytes: MAX_SIMULATION_PAYLOAD_BYTES + 1 },
    { decodedBytes: undefined }, { decodedSha256: undefined }, { compression: 'brotli' },
    { compression: undefined }, { path: '../terrain.bin.gz' }, { path: 'https://example.com/collision.gz' },
  ]) assert.notDeepEqual(validateSimulationFileRef({ ...ref, ...patch }), []);
});

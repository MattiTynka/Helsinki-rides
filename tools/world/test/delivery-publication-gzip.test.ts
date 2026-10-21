import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gunzipSync} from 'node:zlib';
import {prepareNewPublicationJson} from '../compress_delivery_publication_json.ts';
import {deliverySha} from '../lib/delivery-city-payloads.ts';

const raw = new TextEncoder().encode(JSON.stringify({geometry: Array.from({length: 1000}, () => [1, 2, 3]), notice: 'retain every byte'}));
const ref = {path: 'publication/tram-support-profile.json', bytes: raw.length, sha256: deliverySha(raw)};

test('publication gzip retains exact original JSON bytes and decoded integrity pins', () => {
  const output = prepareNewPublicationJson(ref, Buffer.from(raw), new Set());
  assert.deepEqual(new Uint8Array(gunzipSync(output.bytes)), raw);
  assert.equal(output.target.decodedSha256, ref.sha256);
  assert.equal(output.target.decodedBytes, raw.length);
  assert.equal(output.target.sha256, deliverySha(output.bytes));
  assert.ok(output.target.bytes < ref.bytes);
});

test('an accepted publication hash stays protected after a path alias', () => {
  assert.throws(() => prepareNewPublicationJson({...ref, path: 'publication/new-name.json'}, raw, new Set([ref.sha256])), /immutable/);
});

test('runtime paths and operational bridge chains cannot enter publication compression', () => {
  for (const name of ['cells/model.json', 'publication/../source.json', 'publication/junction-mouths/profile.json', 'publication/bridge-reconstruction.json']) {
    assert.throws(() => prepareNewPublicationJson({...ref, path: name}, raw, new Set()));
  }
});

test('corrupt pinned bytes and malformed JSON are rejected before producing a derivative', () => {
  const corrupt = raw.slice(); corrupt[0] = 0;
  assert.throws(() => prepareNewPublicationJson(ref, corrupt, new Set()));
  assert.throws(() => prepareNewPublicationJson({...ref, sha256: deliverySha(corrupt)}, corrupt, new Set()));
  assert.throws(() => prepareNewPublicationJson({...ref, bytes: 0}, raw, new Set()));
});

test('oversized decoded publication is refused even with a matching source pin', () => {
  const huge = new Uint8Array(64 * 1024 * 1024 + 1);
  assert.throws(() => prepareNewPublicationJson({...ref, bytes: huge.length, sha256: deliverySha(huge)}, huge, new Set()), /decoded limit/);
});

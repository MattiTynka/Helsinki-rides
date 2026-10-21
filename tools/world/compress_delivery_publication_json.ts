/** Lossless delivery encoding for explicitly selected new, nonruntime JSON publications. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {gzipSync, gunzipSync} from 'node:zlib';
import {validateWorldManifest, type FileRef, type SimulationFileRef, type WorldManifest} from '../../packages/world-schema/src/index.ts';
import {deliveryFile, freshDeliveryDirectory, readDeliveryFile} from './lib/delivery-city.ts';
import {deliverySha, MAX_DELIVERY_DECODED_BYTES} from './lib/delivery-city-payloads.ts';
import {bindDeliveryProducer, verifyDeliveryProducer, publicDeliveryProducer} from './lib/delivery-city-provenance.ts';

type PublishedWorld = WorldManifest & {publicationFiles: (FileRef | SimulationFileRef)[]};

export function prepareNewPublicationJson(ref: FileRef, raw: Uint8Array, protectedHashes: ReadonlySet<string>) {
  assert.match(ref.path, /^publication\/[A-Za-z0-9_./-]+\.json$/);
  assert.ok(!ref.path.split('/').some(part => part === '.' || part === '..'));
  // These publications are authoritative inputs to bridge/junction readers.
  assert.ok(!ref.path.startsWith('publication/junction-mouths/') && !ref.path.includes('reconstruction'));
  assert.ok(!protectedHashes.has(ref.sha256), 'An immutable publication hash cannot be recoded, including aliases');
  assert.equal(raw.length, ref.bytes);
  assert.equal(deliverySha(raw), ref.sha256);
  assert.ok(raw.length > 0 && raw.length <= MAX_DELIVERY_DECODED_BYTES, 'Publication exceeds decoded limit');
  JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));
  const bytes = gzipSync(raw, {level: 9});
  assert.ok(gunzipSync(bytes, {maxOutputLength: MAX_DELIVERY_DECODED_BYTES}).equals(Buffer.from(raw)), 'Decoded publication bytes changed');
  assert.ok(bytes.length < raw.length, 'Publication compression must save bytes');
  const target: SimulationFileRef = {path: ref.path + '.gz', bytes: bytes.length, sha256: deliverySha(bytes),
    compression: 'gzip', decodedBytes: raw.length, decodedSha256: ref.sha256};
  return {bytes, target};
}

function references(value: unknown, result = new Map<string, FileRef>()) {
  if (!value || typeof value !== 'object') return result;
  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && typeof record.sha256 === 'string' && typeof record.bytes === 'number') {
    const ref = record as unknown as FileRef;
    if (result.has(ref.path)) assert.deepEqual(result.get(ref.path), ref);
    result.set(ref.path, ref);
  }
  for (const child of Object.values(record)) references(child, result);
  return result;
}

export function compressDeliveryPublicationJson(o: {world: string; expected: string; immutableWorld: string;
  immutableExpected: string; files: readonly string[]; out: string; release: string}) {
  const producer = bindDeliveryProducer(new URL(import.meta.url));
  const readManifest = (root: string, expected: string) => {
    const bytes = fs.readFileSync(path.join(root, 'manifest.json'));
    assert.equal(deliverySha(bytes), expected);
    const manifest = JSON.parse(bytes.toString()) as PublishedWorld;
    assert.deepEqual(validateWorldManifest(manifest), []);
    assert.ok(Array.isArray(manifest.publicationFiles));
    return manifest;
  };
  assert.match(o.release, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
  assert.ok(o.files.length > 0 && new Set(o.files).size === o.files.length);
  const source = readManifest(o.world, o.expected), immutable = readManifest(o.immutableWorld, o.immutableExpected);
  assert.equal(source.origin.id, immutable.origin.id);
  const protectedHashes = new Set(immutable.publicationFiles.map(ref => ref.sha256));
  const {publicationFiles: ignored, ...runtime} = source;
  for (const ref of references(runtime).values()) protectedHashes.add(ref.sha256);
  const prepared = new Map<string, ReturnType<typeof prepareNewPublicationJson>>();
  for (const name of o.files) {
    const selected = source.publicationFiles.filter(ref => ref.path === name);
    assert.equal(selected.length, 1, 'Select one manifest-pinned publication');
    const ref = selected[0]!;
    assert.ok(!('compression' in ref), 'Select raw JSON only');
    assert.ok(!references(source).has(ref.path + '.gz'), 'Compressed target already exists');
    prepared.set(name, prepareNewPublicationJson(ref, readDeliveryFile(o.world, ref), protectedHashes));
  }
  const next = {...structuredClone(source), worldReleaseId: o.release, builtAt: new Date().toISOString()};
  next.publicationFiles = source.publicationFiles.map(ref => prepared.get(ref.path)?.target ?? ref);
  const proof = Buffer.from(JSON.stringify({schemaVersion: 1, kind: 'lossless-new-publication-json-gzip',
    sourceManifestSha256: o.expected, immutableManifestSha256: o.immutableExpected, producer: publicDeliveryProducer(producer),
    changes: o.files.map(name => ({source: source.publicationFiles.find(ref => ref.path === name), target: prepared.get(name)!.target})),
    preservation: {decodedPublicationBytesLiteral: true, runtimeReferencesLiteral: true, immutablePublicationHashesLiteral: true}}) + '\n');
  const proofRef = {path: `publication/publication-json-gzip.${o.expected.slice(0, 20)}.json`, bytes: proof.length, sha256: deliverySha(proof)};
  next.publicationFiles.push(proofRef);
  const {publicationFiles: updated, worldReleaseId: release, builtAt, ...unchanged} = next;
  const {publicationFiles: original, worldReleaseId: sourceRelease, builtAt: sourceTime, ...expectedUnchanged} = source;
  assert.deepEqual(unchanged, expectedUnchanged, 'Only publication encoding and release identity may change');
  for (const ref of immutable.publicationFiles) assert.ok(next.publicationFiles.some(candidate => candidate.path === ref.path && candidate.sha256 === ref.sha256 && candidate.bytes === ref.bytes));
  assert.deepEqual(validateWorldManifest(next), []);
  const encoded = Buffer.from(JSON.stringify(next, null, 1) + '\n'), refs = references(next);
  const total = encoded.length + [...refs.values()].reduce((sum, ref) => sum + ref.bytes, 0);
  assert.ok(total <= 950_000_000 && refs.size + 1 < 10_000 && encoded.length <= 8_000_000, 'Delivery closure cap');
  verifyDeliveryProducer(producer);
  readManifest(o.world, o.expected);
  readManifest(o.immutableWorld, o.immutableExpected);
  freshDeliveryDirectory(o.world, o.out);
  const outputs = new Map([...prepared.values()].map(value => [value.target.path, value.bytes]));
  outputs.set(proofRef.path, proof);
  for (const ref of refs.values()) {
    const file = deliveryFile(o.out, ref.path);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const bytes = outputs.get(ref.path);
    if (bytes) fs.writeFileSync(file, bytes, {flag: 'wx'});
    else { readDeliveryFile(o.world, ref); fs.linkSync(deliveryFile(o.world, ref.path), file); }
  }
  fs.writeFileSync(path.join(o.out, 'manifest.json'), encoded, {flag: 'wx'});
  return {manifestSha256: deliverySha(encoded), worldBytes: total, files: refs.size + 1,
    publicationsCompressed: prepared.size, savedBytes: o.files.reduce((sum, name) => sum + source.publicationFiles.find(ref => ref.path === name)!.bytes - prepared.get(name)!.bytes.length, 0)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {world: {type: 'string'}, expected: {type: 'string'}, 'immutable-world': {type: 'string'},
    'immutable-expected': {type: 'string'}, file: {type: 'string', multiple: true}, out: {type: 'string'}, release: {type: 'string'}}});
  for (const key of ['world', 'expected', 'immutable-world', 'immutable-expected', 'out', 'release'] as const) assert.ok(values[key]);
  console.log(JSON.stringify(compressDeliveryPublicationJson({world: values.world!, expected: values.expected!, immutableWorld: values['immutable-world']!,
    immutableExpected: values['immutable-expected']!, files: values.file ?? [], out: values.out!, release: values.release!})));
}

// Create a local candidate release with one replacement character. Never rebuild or prune the city.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateWorldManifest, type WorldManifest } from '../../packages/world-schema/src/index.ts';

const { values } = parseArgs({ options: { base: { type: 'string' }, asset: { type: 'string' }, id: { type: 'string' }, out: { type: 'string' }, report: { type: 'string' } } });
for (const key of ['base', 'asset', 'id', 'out', 'report'] as const) if (!values[key]) throw new Error(`--${key} required`);
assert.ok(values.id === 'character-rain' || values.id === 'character-snow');
assert.ok(!existsSync(values.report!));
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const base = path.resolve(values.base!), original = JSON.parse(readFileSync(path.join(base, 'manifest.json'), 'utf8')) as WorldManifest;
assert.deepEqual(validateWorldManifest(original), []);
const manifest = structuredClone(original), bytes = readFileSync(values.asset!), hash = sha(bytes);
const { validateBytes } = await import('gltf-validator');
const validation = await validateBytes(bytes, { maxIssues: 30 });
assert.equal(validation.issues.numErrors, 0, 'replacement must be valid glTF');
const asset = manifest.assets.find(asset => asset.id === values.id);
assert.ok(asset?.kind === 'character');
const previous = { ...asset };
Object.assign(asset, { path: `assets/${values.id}.${hash.slice(0, 10)}.glb`, bytes: bytes.length, sha256: hash });
if (values.id === 'character-rain') {
  Object.assign(manifest, { attribution: manifest.attribution.map(credit => credit === 'Officer locomotion adapted from Quaternius Universal Animation Library, CC0-1.0'
    ? 'Rain officer: supplied Poliisi-uniform adaptation of Rain by Blender Studio, CC BY 4.0; eleven native movement clips retained, gameplay actions and uniform correction by Helsinki project'
    : credit) });
}
type FileRef = { path: string; bytes: number; sha256: string };
function references(value: unknown, out = new Map<string, FileRef>()): Map<string, FileRef> {
  if (!value || typeof value !== 'object') return out;
  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && typeof record.bytes === 'number' && typeof record.sha256 === 'string') out.set(record.path, record as FileRef);
  else for (const child of Object.values(record)) references(child, out);
  return out;
}
const refs = references(manifest);
const release = `senate-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${sha([...refs.values()].map(ref => ref.sha256).sort().join('')).slice(0, 8)}`;
Object.assign(manifest, { worldReleaseId: release, builtAt: new Date().toISOString() });
assert.deepEqual(validateWorldManifest(manifest), []);
const destination = path.resolve(values.out!, release);
assert.ok(!existsSync(destination), 'use a fresh candidate release');
const unchanged: FileRef[] = [];
for (const ref of refs.values()) {
  const target = path.resolve(destination, ref.path);
  assert.ok(target.startsWith(destination + path.sep), 'payload must stay inside release');
  const source = ref.path === asset.path ? path.resolve(values.asset!) : path.resolve(base, ref.path);
  if (ref.path !== asset.path) assert.ok(source.startsWith(base + path.sep));
  const data = readFileSync(source);
  assert.equal(data.length, ref.bytes, ref.path); assert.equal(sha(data), ref.sha256, ref.path);
  mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(source, target);
  if (ref.path !== asset.path) unchanged.push(ref);
}
writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
writeFileSync(values.report!, JSON.stringify({ status: 'STAGED_REQUIRES_RUNTIME_REVIEW', release, previousRelease: original.worldReleaseId,
  previous, replacement: asset, unchangedPayloads: unchanged, unchangedPayloadCount: unchanged.length,
  manifestSha256: sha(readFileSync(path.join(destination, 'manifest.json'))), activePointerChanged: false }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ release, unchangedPayloadCount: unchanged.length, asset: asset.path, activePointerChanged: false }));

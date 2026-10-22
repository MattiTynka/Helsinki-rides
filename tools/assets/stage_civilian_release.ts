// Add only declared civilian assets and their population config to a new immutable world.
// Unchanged city files are verified then hard-linked; source data and its release pointer never change.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateGameplayBundle, validateWorldManifest, validateCivilianAssets, type FileRef, type WorldManifest, type GameplayBundle } from '../../packages/world-schema/src/index.ts';
import { readFacadeGlb } from '../world/lib/facade-glb.ts';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { checkCharacter, type CharacterContract } from '../verify/lib/character-contract.ts';

const { values } = parseArgs({ options: Object.fromEntries(['base', 'assets', 'out', 'release', 'report'].map(k => [k, { type: 'string' as const }])) });
for (const key of ['base', 'assets', 'out', 'release', 'report']) assert.ok(values[key], `--${key} required`);
assert.match(values.release!, /^[a-z0-9][a-z0-9-]{0,95}$/);
const base = path.resolve(values.base!), out = path.resolve(values.out!);
assert.ok(!fs.existsSync(out) && !fs.existsSync(values.report!), 'Use fresh output paths');
assert.ok(out !== base && !out.startsWith(base + path.sep), 'Keep source world immutable');
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const source = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')) as WorldManifest;
assert.deepEqual(validateWorldManifest(source), []);
const manifest = structuredClone(source);
const gameplayBytes = fs.readFileSync(path.join(base, source.gameplay.path));
assert.equal(gameplayBytes.length, source.gameplay.bytes, 'Source gameplay byte count differs from its manifest');
assert.equal(hash(gameplayBytes), source.gameplay.sha256, 'Source gameplay hash differs from its manifest');
const gameplay = JSON.parse(gameplayBytes.toString('utf8')) as GameplayBundle;
const variants = (['rain-black', 'rain-white', 'snow-black', 'agent47'] as const)
  .filter(id => fs.existsSync(path.join(values.assets!, `character-civilian-${id}.glb`)));
assert.ok(variants.length > 0, 'No civilian assets supplied');
const writes = new Map<string, Uint8Array>();
const reference = (name: string, data: Uint8Array): FileRef => { writes.set(name, data); return { path: name, bytes: data.length, sha256: hash(data) }; };
const assetReports = [];
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const contract = JSON.parse(fs.readFileSync(new URL('../../content/assets/character-civilian.contract.json', import.meta.url), 'utf8')) as CharacterContract;
for (const variant of variants) {
  const id = `character-civilian-${variant}`, bytes = fs.readFileSync(path.join(values.assets!, `${id}.glb`));
  const json = readFacadeGlb(bytes).json as any;
  assert.ok(json.skins?.length && json.animations?.some((a: any) => a.name === 'walk'), `${id}: animated character required`);
  for (const name of ['idle', 'walk', 'death']) assert.ok(json.animations.some((a: any) => a.name === name), `${id}: ${name} clip required`);
  assert.ok(bytes.length < 8 * 1024 * 1024, `${id}: exceeds civilian transfer budget`);
  const triangles = json.meshes.flatMap((m: any) => m.primitives).reduce((sum: number, p: any) => sum + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0);
  assert.ok(triangles <= 14000, `${id}: exceeds 14,000 triangle NPC budget (${triangles})`);
  const document = await io.readBinary(bytes);
  const checks = await checkCharacter(document, contract, 'npc', bytes.length);
  assert.deepEqual(checks.filter(check => !check.pass), [], `${id}: character contract failed`);
  const ref = reference(`assets/${id}.${hash(bytes).slice(0, 16)}.glb`, bytes);
  (manifest.assets as any[]).push({ ...ref, id, kind: 'character' });
  assetReports.push({ id, ...ref, triangles, checks });
}
// Refresh the release's own notices, never a hard-linked source world's bytes.
for (const [published, local] of [['asset-credits.json', 'content/releases/asset-credits.json'], ['third-party-notices.md', 'THIRD_PARTY_NOTICES.md']]) {
  const name = `publication/${published}`, bytes = fs.readFileSync(new URL(`../../${local}`, import.meta.url));
  const item = reference(name, bytes);
  (manifest as any).publicationFiles = [...(manifest.publicationFiles ?? []).filter(ref => ref.path !== name), item];
}
const nextGameplay = { ...gameplay, civilianVariants: variants };
assert.deepEqual(validateGameplayBundle(nextGameplay), []);
assert.deepEqual(validateCivilianAssets(nextGameplay.civilianVariants, manifest.assets), []);
const gameBytes = Buffer.from(JSON.stringify(nextGameplay) + '\n');
Object.assign(manifest, { worldReleaseId: values.release, builtAt: new Date().toISOString(),
  gameplay: reference(`gameplay/civilian-population.${hash(gameBytes).slice(0, 16)}.json`, gameBytes),
  attribution: [...manifest.attribution,
    'Civilian Snow and Rain: Blender Studio, CC BY 4.0; game derivatives and skin variant by Helsinki Rides; locomotion adapted from Quaternius Universal Animation Library, CC0-1.0',
    ...(variants.includes('agent47') ? ['Agent 47 (rigged+face morphs) by Veterock (windofglass), CC BY-NC 4.0; animated and optimized for Helsinki Rides; https://sketchfab.com/3d-models/agent-47-riggedface-morphs-1680cad927304bb687d6a9ad5b9dd98a'] : [])] });
assert.deepEqual(validateWorldManifest(manifest), []);
function refs(value: unknown, found = new Map<string, FileRef>()): Map<string, FileRef> {
  if (!value || typeof value !== 'object') return found;
  const r = value as Record<string, unknown>;
  if (typeof r.path === 'string' && typeof r.bytes === 'number' && typeof r.sha256 === 'string') {
    const previous = found.get(r.path);
    if (previous) assert.deepEqual(previous, { path: r.path, bytes: r.bytes, sha256: r.sha256 });
    found.set(r.path, { path: r.path, bytes: r.bytes, sha256: r.sha256 });
  } else for (const child of Object.values(r)) refs(child, found);
  return found;
}
const references = refs(manifest); let retained = 0;
for (const ref of references.values()) {
  assert.ok(ref.path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)), 'Unsafe payload path');
  const target = path.resolve(out, ref.path), original = path.resolve(base, ref.path);
  assert.ok(target.startsWith(out + path.sep) && original.startsWith(base + path.sep));
  const data = writes.get(ref.path) ?? fs.readFileSync(original);
  assert.equal(data.length, ref.bytes); assert.equal(hash(data), ref.sha256);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (writes.has(ref.path)) fs.writeFileSync(target, data, { flag: 'wx' });
  else { assert.ok(fs.lstatSync(original).isFile() && !fs.lstatSync(original).isSymbolicLink()); fs.linkSync(original, target); retained++; }
}
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'manifest.json'), manifestBytes, { flag: 'wx' });
fs.writeFileSync(values.report!, JSON.stringify({ status: 'STAGED_REQUIRES_RUNTIME_REVIEW', sourceRelease: source.worldReleaseId,
  worldRelease: manifest.worldReleaseId, manifestSha256: hash(manifestBytes), retainedPayloads: retained, assets: assetReports,
  variants, worldBytes: manifestBytes.length + [...references.values()].reduce((n, ref) => n + ref.bytes, 0) }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ release: values.release, variants, retainedPayloads: retained, manifestSha256: hash(manifestBytes) }));

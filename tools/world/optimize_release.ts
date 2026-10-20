// Produce a new immutable derivative. The source release and publication descriptor stay untouched.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { validateWorldManifest, type FileRef, type SimulationFileRef, type VisualLod, type WorldManifest } from '../../packages/world-schema/src/index.ts';
import { compactGlb } from './lib/compact-glb.ts';
import { externalizeCellImages } from './lib/shared-textures.ts';
import { optimizeCityLods, optimizeExactCityMesh } from './lib/optimize-city-lods.ts';
import { readFacadeGlb } from './lib/facade-glb.ts';
import { compressActor } from './lib/compress-actor.ts';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, release: { type: 'string' }, report: { type: 'string' }, 'far-assets': { type: 'string' }, cells: { type: 'string' }, native: { type: 'boolean', default: false } } });
assert.ok(values.source && values.out && values.release && values.report, '--source, --out, --release and --report required');
assert.match(values.release, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const source = path.resolve(values.source), out = path.resolve(values.out), reportPath = path.resolve(values.report);
assert.ok(!fs.existsSync(out) && !fs.existsSync(reportPath), 'Use fresh output and evidence paths');
assert.ok(out !== source && !out.startsWith(source + path.sep), 'Derivative must be outside its source');
const sourceBytes = fs.readFileSync(path.join(source, 'manifest.json'));
const manifest = JSON.parse(sourceBytes.toString()) as WorldManifest & { publicationFiles?: FileRef[]; optimization?: unknown };
assert.deepEqual(validateWorldManifest(manifest), []);
assert.notEqual(manifest.worldReleaseId, values.release);
assert.ok(!manifest.sharedTextures?.length, 'Use the original embedded-texture release as the optimization baseline');
assert.ok(!manifest.terrain.compression && manifest.cells.every(cell => !cell.collision.compression), 'Use the original uncompressed simulation baseline');
assert.ok(!manifest.assets.some(a => /kaamos|gt[-_]?40/i.test(a.id)), 'Restricted vehicle cannot enter a derivative');
const original = structuredClone(manifest), only = values.cells ? new Set(values.cells.split(',')) : null;
assert.ok(!only || [...only].every(id => manifest.cells.some(c => c.id === id)), 'Unknown pilot cell');
const shared = new Map<string, FileRef>(), written = new Map<string, FileRef>(), checked = new Map<string, FileRef>();
const cells: unknown[] = [], binaries: unknown[] = [], actors: unknown[] = [];
let compactionSavedBytes = 0;
fs.mkdirSync(out, { recursive: true });

function relativeFile(root: string, name: string): string {
  assert.ok(name.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)), 'Unsafe payload path');
  const target = path.resolve(root, ...name.split('/'));
  assert.ok(target.startsWith(root + path.sep));
  return target;
}
function read(ref: FileRef): Uint8Array {
  const file = relativeFile(source, ref.path), info = fs.lstatSync(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Source payload must be a regular file');
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, ref.bytes, `${ref.path}: source size mismatch`);
  assert.equal(sha(bytes), ref.sha256, `${ref.path}: source hash mismatch`);
  checked.set(ref.path, ref);
  return bytes;
}
function write(name: string, bytes: Uint8Array): FileRef {
  const ref = { path: name, bytes: bytes.length, sha256: sha(bytes) }, prior = written.get(name);
  if (prior) { assert.deepEqual(prior, ref); return prior; }
  const file = relativeFile(out, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
  written.set(name, ref); return ref;
}
function retain(ref: FileRef): FileRef {
  if (!checked.has(ref.path)) read(ref);
  if (written.has(ref.path)) { assert.deepEqual(written.get(ref.path), { path: ref.path, bytes: ref.bytes, sha256: ref.sha256 }); return ref; }
  const file = relativeFile(out, ref.path); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.linkSync(relativeFile(source, ref.path), file);
  written.set(ref.path, { path: ref.path, bytes: ref.bytes, sha256: ref.sha256 }); return ref;
}
function geometryStats(bytes: Uint8Array): Pick<VisualLod, 'triangles' | 'drawCalls' | 'atlases'> {
  const j = readFacadeGlb(bytes).json as any;
  let triangles = 0, drawCalls = 0;
  for (const n of j.nodes ?? []) if (n.mesh !== undefined) for (const p of j.meshes[n.mesh].primitives) {
    triangles += j.accessors[p.indices ?? p.attributes.POSITION].count / 3; drawCalls++;
  }
  return { triangles, drawCalls, atlases: j.images?.length ?? 0 };
}
function visual(bytes: Uint8Array, cell: string, tier: string, template: VisualLod): VisualLod {
  const compact = compactGlb(bytes); compactionSavedBytes += compact.receipt.savedBytes;
  const external = externalizeCellImages(compact.bytes);
  for (const image of external.images) shared.set(image.path, write(image.path, image.bytes));
  const final = compactGlb(external.bytes).bytes, ref = write(`cells/${cell}.${tier}.${sha(final).slice(0, 16)}.glb`, final);
  return { ...template, ...ref, ...geometryStats(final) };
}
function simulation(ref: SimulationFileRef): SimulationFileRef {
  assert.equal(ref.compression, undefined, 'Use an uncompressed baseline for this derivative');
  const raw = read(ref), compressed = gzipSync(raw, { level: 6, mtime: 0 } as any);
  assert.deepEqual(gunzipSync(compressed), raw, 'Lossless simulation compression failed');
  binaries.push({ source: ref.path, decodedBytes: raw.length, storedBytes: compressed.length });
  if (compressed.length >= raw.length) return retain(ref);
  return { ...ref, ...write(`${ref.path}.${sha(compressed).slice(0, 12)}.gz`, compressed), compression: 'gzip', decodedBytes: raw.length, decodedSha256: ref.sha256 };
}

for (const cell of manifest.cells as any[]) {
  const near = read(cell.visual.lod0), far = read(cell.visual.lod2);
  if (only && !only.has(cell.id)) {
    for (const ref of Object.values(cell.visual) as FileRef[]) retain(ref);
    cell.collision = simulation(cell.collision); continue;
  }
  const exact = await optimizeExactCityMesh(near);
  const exactNear = exact.bytes;
  const optimized = await optimizeCityLods({ lod0: exactNear, lod2: far, boundsXZ: cell.boundsXZ });
  const nextNear = visual(exactNear, cell.id, 'lod0', cell.visual.lod0);
  let mid = optimized.lod1;
  if (cell.visual.lod1) {
    const previous = read(cell.visual.lod1);
    if (!mid || geometryStats(previous).triangles < geometryStats(mid).triangles) mid = previous;
  }
  const nextMid = mid ? visual(mid, cell.id, 'lod1', cell.visual.lod1 ?? cell.visual.lod0) : nextNear;
  const nextFar = visual(optimized.lod2, cell.id, 'lod2', cell.visual.lod2);
  cells.push({ id: cell.id, before: { lod0: cell.visual.lod0.triangles, lod1: cell.visual.lod1?.triangles ?? null, lod2: cell.visual.lod2.triangles }, after: { lod0: nextNear.triangles, lod1: nextMid.triangles, lod2: nextFar.triangles }, exactNear: exact.stats, stats: optimized.stats });
  cell.visual = { lod0: nextNear, lod1: nextMid, lod2: nextFar };
  cell.collision = simulation(cell.collision);
  console.log(`${cell.id}: ${nextNear.triangles}/${nextMid.triangles}/${nextFar.triangles} triangles`);
}
(manifest as any).terrain = simulation(manifest.terrain);
for (const ref of [manifest.roads, manifest.gameplay, ...(manifest.scenery ? [manifest.scenery] : []), ...(manifest.publicationFiles ?? [])]) retain(ref);
for (const asset of manifest.assets as any[]) {
  if (asset.kind !== 'character' && asset.kind !== 'vehicle') { retain(asset); continue; }
  const result = await compressActor(read(asset)); actors.push({ id: asset.id, ...result.receipt });
  if (!result.receipt.applied) { retain(asset); continue; }
  const ref = write(`assets/${asset.id}.${sha(result.bytes).slice(0, 16)}.glb`, result.bytes);
  Object.assign(asset, ref, { optimization: { lossless: true, sourceSha256: result.receipt.originalSha256, semanticSha256: result.receipt.semanticSha256 } });
}
if (values['far-assets']) for (const id of ['vehicle-lumi-gt', 'vehicle-patrol', 'vehicle-revontuli']) {
  const file = path.resolve(values['far-assets'], `${id}-far-low.glb`), bytes = fs.readFileSync(file);
  const ref = { ...write(`assets/${id}-far-low.${sha(bytes).slice(0, 12)}.glb`, bytes), id: `${id}-far-low`, kind: 'prop' as const };
  const index = manifest.assets.findIndex(a => a.id === ref.id);
  if (index >= 0) (manifest.assets as any[])[index] = ref; else (manifest.assets as any[]).push(ref);
}
(manifest as any).sharedTextures = [...shared.values()].sort((a, b) => a.path.localeCompare(b.path));
(manifest as any).worldReleaseId = values.release;
(manifest as any).builtAt = new Date().toISOString();
const summary = {
  schemaVersion: 1, sourceRelease: original.worldReleaseId, sourceManifestSha256: sha(sourceBytes),
  derivativeRelease: values.release, completeMapRetained: true, collisionAndTerrainDecodedExact: true,
  originalImagePayloadsExact: true, groundAndCellBordersProtected: true,
  compactionSavedBytes, sharedTextureFiles: shared.size, sharedTextureBytes: [...shared.values()].reduce((n, r) => n + r.bytes, 0),
  simulationStoredBytes: binaries.reduce((n: number, r: any) => n + r.storedBytes, 0),
  simulationDecodedBytes: binaries.reduce((n: number, r: any) => n + r.decodedBytes, 0),
  triangles: Object.fromEntries(['lod0', 'lod1', 'lod2'].map(tier => [tier, manifest.cells.reduce((n, c) => n + (c.visual as any)[tier].triangles, 0)])),
  actors,
};
const note = write('publication/model-optimization.json', Buffer.from(JSON.stringify(summary, null, 2) + '\n'));
(manifest as any).publicationFiles = [...(manifest.publicationFiles ?? []), note];
assert.deepEqual(validateWorldManifest(manifest), []);
// Remove replaced optional far files from this fresh derivative only; the source remains linked and intact.
const refs = new Set<string>();
function collect(value: any): void { if (!value || typeof value !== 'object') return; if (typeof value.path === 'string' && typeof value.sha256 === 'string') refs.add(value.path); for (const v of Object.values(value)) collect(v); }
collect(manifest);
for (const name of written.keys()) if (!refs.has(name)) { fs.unlinkSync(relativeFile(out, name)); written.delete(name); }
const finalManifest = Buffer.from(JSON.stringify(manifest, null, 1) + '\n'); fs.writeFileSync(path.join(out, 'manifest.json'), finalManifest, { flag: 'wx' });
assert.equal(sha(fs.readFileSync(path.join(source, 'manifest.json'))), sha(sourceBytes), 'Source manifest changed');
const worldBytes = finalManifest.length + [...written.values()].reduce((n, r) => n + r.bytes, 0);
assert.ok(worldBytes < (values.native ? 2_000_000_000 : 950_000_000), values.native ? 'Derivative exceeds the native world budget' : 'Derivative exceeds the Pages world budget');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ ...summary, status: 'BUILT', manifestSha256: sha(finalManifest), worldBytes, files: written.size + 1, cells, binaries }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...summary, worldBytes, manifestSha256: sha(finalManifest) }));

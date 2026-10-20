// Record each cell's collision extent in a fresh derivative (manifest `collision.boundsXZ`). Streaming residency
// measures cells by it: a building belongs to one cell but can reach far into its neighbours' squares. Every source
// payload is hard-linked unchanged; only the manifest gains the extents.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { decodeSimulationPayload, parseCollisionBundle, validateWorldManifest, type FileRef, type WorldManifest } from '../../packages/world-schema/src/index.ts';

type Bounds = [number, number, number, number];

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, release: { type: 'string' }, report: { type: 'string' } } });
assert.ok(values.source && values.out && values.release && values.report, '--source, --out, --release and --report required');
assert.match(values.release, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const source = path.resolve(values.source), out = path.resolve(values.out), reportPath = path.resolve(values.report);
assert.ok(!fs.existsSync(out) && !fs.existsSync(reportPath), 'Use fresh output and evidence paths');
assert.ok(out !== source && !out.startsWith(source + path.sep), 'Derivative must be outside its source');
const sourceBytes = fs.readFileSync(path.join(source, 'manifest.json'));
const manifest = JSON.parse(sourceBytes.toString()) as WorldManifest & { publicationFiles?: FileRef[] };
assert.deepEqual(validateWorldManifest(manifest), []);
assert.notEqual(manifest.worldReleaseId, values.release);
assert.ok(manifest.cells.every(c => c.collision.boundsXZ === undefined), 'Source already records collision extents');

function relativeFile(root: string, name: string): string {
  assert.ok(name.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)), 'Unsafe payload path');
  const target = path.resolve(root, ...name.split('/'));
  assert.ok(target.startsWith(root + path.sep));
  return target;
}
function read(ref: FileRef): Buffer {
  const file = relativeFile(source, ref.path), info = fs.lstatSync(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Source payload must be a regular file');
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, ref.bytes, `${ref.path}: source size mismatch`);
  assert.equal(sha(bytes), ref.sha256, `${ref.path}: source hash mismatch`);
  return bytes;
}
const written = new Map<string, FileRef>();
function write(name: string, bytes: Uint8Array): FileRef {
  const ref = { path: name, bytes: bytes.length, sha256: sha(bytes) };
  assert.ok(!written.has(name), `${name}: already written`);
  const file = relativeFile(out, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
  written.set(name, ref); return ref;
}

// Retain every pinned payload exactly, checked against its manifest size and hash.
const refs = new Map<string, FileRef>();
function collect(value: any): void {
  if (!value || typeof value !== 'object') return;
  if (typeof value.path === 'string' && typeof value.sha256 === 'string') {
    const prior = refs.get(value.path);
    assert.ok(!prior || (prior.bytes === value.bytes && prior.sha256 === value.sha256), `${value.path}: conflicting references`);
    refs.set(value.path, { path: value.path, bytes: value.bytes, sha256: value.sha256 });
  }
  for (const v of Object.values(value)) collect(v);
}
collect(manifest);
fs.mkdirSync(out, { recursive: true });
for (const ref of refs.values()) {
  read(ref);
  const file = relativeFile(out, ref.path); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.linkSync(relativeFile(source, ref.path), file);
  written.set(ref.path, ref);
}

/** The XZ extent of every triangle the world inserts for this bundle (colliders without triangles are skipped). */
function collisionExtent(bytes: Uint8Array): Bounds | null {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const c of parseCollisionBundle(bytes).colliders) {
    for (const i of c.indices) {
      const x = c.positions[i * 3]!, z = c.positions[i * 3 + 2]!;
      assert.ok(Number.isFinite(x) && Number.isFinite(z), 'Collision vertex is not finite');
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
  }
  return x0 <= x1 ? [x0, z0, x1, z1] : null;
}

let beyondGrid = 0, largestOverhang = 0;
for (const cell of manifest.cells) {
  const extent = collisionExtent(await decodeSimulationPayload(read(cell.collision), cell.collision));
  // A cell without collision triangles keeps its grid square.
  const b = extent ?? [...cell.boundsXZ] as Bounds, g = cell.boundsXZ;
  const overhang = Math.max(g[0] - b[0], g[1] - b[1], b[2] - g[2], b[3] - g[3], 0);
  if (overhang > 0) beyondGrid++;
  largestOverhang = Math.max(largestOverhang, overhang);
  (cell.collision as { boundsXZ?: Bounds }).boundsXZ = b;
}
(manifest as any).worldReleaseId = values.release;
(manifest as any).builtAt = new Date().toISOString();
const summary = {
  schemaVersion: 1, sourceRelease: JSON.parse(sourceBytes.toString()).worldReleaseId, sourceManifestSha256: sha(sourceBytes),
  derivativeRelease: values.release, sourcePayloadsRetainedExact: true, cells: manifest.cells.length,
  cellsReachingBeyondGrid: beyondGrid, largestOverhangMeters: largestOverhang,
};
const note = write('publication/collision-bounds.json', Buffer.from(JSON.stringify(summary, null, 2) + '\n'));
(manifest as any).publicationFiles = [...(manifest.publicationFiles ?? []), note];
assert.deepEqual(validateWorldManifest(manifest), []);
const finalManifest = Buffer.from(JSON.stringify(manifest, null, 1) + '\n'); fs.writeFileSync(path.join(out, 'manifest.json'), finalManifest, { flag: 'wx' });
assert.equal(sha(fs.readFileSync(path.join(source, 'manifest.json'))), sha(sourceBytes), 'Source manifest changed');
const worldBytes = finalManifest.length + [...written.values()].reduce((n, r) => n + r.bytes, 0);
assert.ok(worldBytes < 950_000_000, 'Derivative exceeds the Pages world budget');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ ...summary, status: 'BUILT', manifestSha256: sha(finalManifest), worldBytes, files: written.size + 1 }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...summary, worldBytes, manifestSha256: sha(finalManifest) }));

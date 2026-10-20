// Add the low preset's reduced texture tier to a fresh derivative. Every source payload is hard-linked unchanged;
// each large shared KTX2 texture gains a copy without its top mip level whose remaining levels are byte-identical.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateWorldManifest, type FileRef, type ReducedTextureRef, type WorldManifest } from '../../packages/world-schema/src/index.ts';
import { assertSameLevels, dropTopMip, readKtx2Layout } from './lib/ktx2-mips.ts';

/** Textures below this size are already cheap; reducing them would only add files. */
const MIN_REDUCED_SOURCE_SIZE = 1024;
const ZSTANDARD = 2;

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
assert.ok(manifest.sharedTextures?.length, 'Use an optimized release with shared textures');
assert.ok(!manifest.sharedTexturesM1, 'Source already has a reduced texture tier');

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
  const ref = { path: name, bytes: bytes.length, sha256: sha(bytes) }, prior = written.get(name);
  if (prior) { assert.deepEqual(prior, ref); return prior; }
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

const reduced: ReducedTextureRef[] = [], skipped: Record<string, number> = {};
let sourceTextureBytes = 0;
for (const ref of manifest.sharedTextures) {
  sourceTextureBytes += ref.bytes;
  if (!ref.path.endsWith('.ktx2')) { skipped.png = (skipped.png ?? 0) + 1; continue; }
  const bytes = read(ref), layout = readKtx2Layout(bytes);
  const reason = layout.supercompression !== ZSTANDARD ? 'not-zstandard' : layout.levelCount < 2 ? 'single-level'
    : Math.max(layout.width, layout.height) < MIN_REDUCED_SOURCE_SIZE ? 'small' : null;
  if (reason) { skipped[reason] = (skipped[reason] ?? 0) + 1; continue; }
  const smaller = dropTopMip(bytes);
  assertSameLevels(bytes, smaller);
  reduced.push({ ...write(`textures-m1/${sha(smaller)}.ktx2`, smaller), source: ref.path });
}
(manifest as any).sharedTexturesM1 = reduced.sort((a, b) => a.source.localeCompare(b.source));
(manifest as any).worldReleaseId = values.release;
(manifest as any).builtAt = new Date().toISOString();
const summary = {
  schemaVersion: 1, sourceRelease: JSON.parse(sourceBytes.toString()).worldReleaseId, sourceManifestSha256: sha(sourceBytes),
  derivativeRelease: values.release, sourcePayloadsRetainedExact: true, remainingMipLevelsExact: true,
  minimumReducedSourceSize: MIN_REDUCED_SOURCE_SIZE, reducedTextures: reduced.length, skipped,
  sourceTextureBytes, reducedTextureBytes: reduced.reduce((n, r) => n + r.bytes, 0),
  reducedSourceBytes: reduced.reduce((n, r) => n + manifest.sharedTextures!.find(t => t.path === r.source)!.bytes, 0),
};
const note = write('publication/texture-tier.json', Buffer.from(JSON.stringify(summary, null, 2) + '\n'));
(manifest as any).publicationFiles = [...(manifest.publicationFiles ?? []), note];
assert.deepEqual(validateWorldManifest(manifest), []);
const finalManifest = Buffer.from(JSON.stringify(manifest, null, 1) + '\n'); fs.writeFileSync(path.join(out, 'manifest.json'), finalManifest, { flag: 'wx' });
assert.equal(sha(fs.readFileSync(path.join(source, 'manifest.json'))), sha(sourceBytes), 'Source manifest changed');
const worldBytes = finalManifest.length + [...written.values()].reduce((n, r) => n + r.bytes, 0);
assert.ok(worldBytes < 950_000_000, 'Derivative exceeds the Pages world budget');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ ...summary, status: 'BUILT', manifestSha256: sha(finalManifest), worldBytes, files: written.size + 1, textures: reduced }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...summary, worldBytes, manifestSha256: sha(finalManifest) }));

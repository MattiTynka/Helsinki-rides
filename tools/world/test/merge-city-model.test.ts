import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { mergeCityModels } from '../merge_city_model.ts';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
function setup(t: TestContext) {
  const prefix = path.join(tmpdir(), 'helsinki-city-merge-'), root = mkdtempSync(prefix);
  t.after(() => { if (!path.resolve(root).startsWith(path.resolve(prefix))) throw new Error('unexpected fixture path'); rmSync(root, { recursive: true }); });
  const base = path.join(root, 'base'), expanded = path.join(root, 'expanded'), out = path.join(root, 'out');
  const write = (directory: string, pages: string[], ids: string[]) => {
    mkdirSync(path.join(directory, 'textures'), { recursive: true });
    const textures = pages.map(page => {
      const file = `textures/${page}.png`; writeFileSync(path.join(directory, file), `pixels-${page}`);
      return { file, width: 16, height: 16, sourceSha256: sha(page) };
    });
    const chunks: Buffer[] = []; let offset = 0;
    const put = (values: number[]) => { const bytes = Buffer.from(Float32Array.from(values).buffer), ref = { offset, bytes: bytes.length }; chunks.push(bytes); offset += bytes.length; return ref; };
    const buildings = ids.map(id => ({ id, textured: true, triangles: 1, sourceTile: 'fixture.glb', parts: [{ texture: pages.indexOf(id === 'accepted' ? 'A' : 'C'), vertices: 3, colour: [1, 1, 1], positions: put([0, 0, 0, 1, 0, 0, 1, 1, 0]), uvs: put([0, 0, 1, 0, 1, 1]), indices: put([0, 1, 2]) }] }));
    const binary = Buffer.concat(chunks); writeFileSync(path.join(directory, 'city-model.bin'), binary);
    const model = { schemaVersion: 1, kind: 'city-model-buildings', frame: 'ENU metres', originId: 'same-origin', originProjected: [25497350, 6672960, 7.5], source: { tilesetVersion: 'fixed-vintage' }, binary: { file: 'city-model.bin', bytes: binary.length, sha256: sha(binary) }, textures, buildings, stats: {} };
    writeFileSync(path.join(directory, 'city-model.json'), JSON.stringify(model));
    return model;
  };
  const baseModel = write(base, ['A', 'B'], ['accepted']);
  const expandedModel = write(expanded, ['C', 'B', 'A'], ['new', 'accepted']);
  const saveExpanded = () => writeFileSync(path.join(expanded, 'city-model.json'), JSON.stringify(expandedModel));
  return { base, expanded, out, baseModel, expandedModel, saveExpanded };
}

test('expanded source pages may reorder while accepted pages, records and binary remain exact prefixes', t => {
  const f = setup(t), report = mergeCityModels(f);
  const output = JSON.parse(readFileSync(path.join(f.out, 'city-model.json'), 'utf8'));
  assert.deepEqual(output.textures.slice(0, 2), f.baseModel.textures);
  assert.deepEqual(output.buildings.slice(0, 1), f.baseModel.buildings);
  assert.deepEqual(output.buildings.map((b: { id: string }) => b.id), ['accepted', 'new']);
  assert.equal(output.buildings[1].parts[0].texture, 2);
  const originalBinary = readFileSync(path.join(f.base, 'city-model.bin'));
  assert.deepEqual(readFileSync(path.join(f.out, 'city-model.bin')).subarray(0, originalBinary.length), originalBinary);
  for (const texture of f.baseModel.textures) assert.deepEqual(readFileSync(path.join(f.out, texture.file)), readFileSync(path.join(f.base, texture.file)));
  assert.equal(report.overlapVerified, 1);
  assert.deepEqual(report.added, { buildings: 1, textures: 1 });
});

test('same source hash with changed decoded texture is rejected before output', t => {
  const f = setup(t); writeFileSync(path.join(f.expanded, 'textures/A.png'), 'wrong pixels');
  assert.throws(() => mergeCityModels(f), /different decoded pixels/);
});

test('overlapping source geometry changes cannot be hidden by keeping the accepted building', t => {
  const f = setup(t), bytes = readFileSync(path.join(f.expanded, 'city-model.bin'));
  bytes.writeFloatLE(50, f.expandedModel.buildings[1]!.parts[0]!.positions.offset);
  writeFileSync(path.join(f.expanded, 'city-model.bin'), bytes); f.expandedModel.binary.sha256 = sha(bytes); f.saveExpanded();
  assert.throws(() => mergeCityModels(f), /overlap positions changed/);
});

test('changed origin and city vintage are independently rejected', t => {
  const f = setup(t); f.expandedModel.originProjected[2] = 8; f.saveExpanded();
  assert.throws(() => mergeCityModels(f), /originProjected mismatch/);
  f.expandedModel.originProjected[2] = 7.5; f.expandedModel.source.tilesetVersion = 'new-vintage'; f.saveExpanded();
  assert.throws(() => mergeCityModels(f), /vintage mismatch/);
});

test('incomplete overlap and duplicate building IDs fail closed', t => {
  const f = setup(t); f.expandedModel.buildings.pop(); f.saveExpanded();
  assert.throws(() => mergeCityModels(f), /omits accepted building/);
  f.expandedModel.buildings.push(f.expandedModel.buildings[0]!); f.saveExpanded();
  assert.throws(() => mergeCityModels(f), /duplicate or empty building id/);
});

test('binary hashes and escaped texture file paths are checked', t => {
  const f = setup(t); f.expandedModel.binary.sha256 = '0'.repeat(64); f.saveExpanded();
  assert.throws(() => mergeCityModels(f), /binary hash or size mismatch/);
  f.expandedModel.binary.sha256 = sha(readFileSync(path.join(f.expanded, 'city-model.bin')));
  f.expandedModel.textures[0]!.file = '../outside.png'; f.saveExpanded();
  assert.throws(() => mergeCityModels(f), /escapes its directory/);
});

test('explicit appended tile subset preserves omitted accepted records and shares immutable texture files', t => {
  const f = setup(t); f.expandedModel.buildings.pop(); f.saveExpanded();
  const report = mergeCityModels({ ...f, appendSnapshot: true, linkTextures: true });
  const output = JSON.parse(readFileSync(path.join(f.out, 'city-model.json'), 'utf8'));
  assert.deepEqual(output.buildings[0], f.baseModel.buildings[0]);
  assert.equal(report.overlapVerified, 0); assert.equal(report.added.buildings, 1);
  const original = statSync(path.join(f.base, f.baseModel.textures[0]!.file));
  const linked = statSync(path.join(f.out, output.textures[0].file));
  assert.equal(linked.ino, original.ino); assert.equal(linked.dev, original.dev); assert.ok(linked.nlink >= 2);
});

test('append subset still rejects changed geometry for every overlapping accepted building', t => {
  const f = setup(t), binary = readFileSync(path.join(f.expanded, 'city-model.bin'));
  binary.writeFloatLE(13, f.expandedModel.buildings[1]!.parts[0]!.positions.offset);
  writeFileSync(path.join(f.expanded, 'city-model.bin'), binary); f.expandedModel.binary.sha256 = sha(binary); f.saveExpanded();
  assert.throws(() => mergeCityModels({ ...f, appendSnapshot: true, linkTextures: true }), /overlap positions changed/);
});

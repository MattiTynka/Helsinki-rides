// Build a fresh delivery world with the exact raised centre bars removed from visual and physical geometry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {validateBytes} from 'gltf-validator';
import {validateWorldManifest, type FileRef, type SimulationFileRef, type VisualLod, type WorldManifest} from '../../packages/world-schema/src/index.ts';
import {deliveryFile, freshDeliveryDirectory, readDeliveryFile} from './lib/delivery-city.ts';
import {decodeDeliveryCityGlb, decodeDeliverySimulation, deliveryCollisionBounds, deliveryGeometryStats, deliverySha, encodeDeliverySimulation} from './lib/delivery-city-payloads.ts';
import {deliveryFacadeImages} from './apply_delivery_facade_charts.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';
import {reuseGroundGlb} from './lib/reuse-ground-glb.ts';
import {legacyCentreBarCells, planCentreBarVisualRemoval, countCentreBarVisualTriangles, removeCentreBarCollision} from './lib/bridge-centre-bars.ts';
import type {ReconstructedBridge} from './lib/bridge-reconstruction.ts';

const BASELINE_MANIFEST = '86ec02dc2f28e4c9dd93819b1c8ef44fbbd0a1c8c619dc266209065ade7b16b2';
const CELL_COUNTS = {c_p02_m07: {detail: 3868, coarse: 2604}, c_p02_m08: {detail: 1804, coarse: 1248}};
type PublishedWorld = WorldManifest & {publicationFiles: SimulationFileRef[]};
type Mutable<T> = {-readonly [K in keyof T]: T[K] extends readonly (infer V)[] ? Mutable<V>[] : T[K] extends object ? Mutable<T[K]> : T[K]};

function references(value: unknown, result = new Map<string, FileRef>()): Map<string, FileRef> {
  if (!value || typeof value !== 'object') return result;
  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && typeof record.sha256 === 'string' && typeof record.bytes === 'number') {
    const ref = {path: record.path, sha256: record.sha256, bytes: record.bytes};
    if (result.has(ref.path)) assert.deepEqual(result.get(ref.path), ref, 'Conflicting payload aliases');
    result.set(ref.path, ref);
  }
  for (const child of Object.values(record)) references(child, result);
  return result;
}

export async function removeBridgeCentreBars(options: {world: string; out: string; release: string; receipt?: string; expected?: string}) {
  assert.match(options.release, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
  assert.ok(!fs.existsSync(options.out), 'Candidate output must be fresh');
  if (options.receipt) {
    assert.ok(!fs.existsSync(options.receipt), 'Receipt must be fresh');
    for (const root of [options.world, options.out]) assert.ok(!path.resolve(options.receipt).startsWith(path.resolve(root) + path.sep), 'Receipt must stay outside the closed world');
  }
  const sourceBytes = fs.readFileSync(path.join(options.world, 'manifest.json')), sourceSha = deliverySha(sourceBytes);
  assert.equal(sourceSha, options.expected ?? BASELINE_MANIFEST, 'Source manifest changed');
  const source = JSON.parse(sourceBytes.toString()) as PublishedWorld;
  assert.deepEqual(validateWorldManifest(source), []);
  const profileRef = source.publicationFiles.find(r => r.path === 'publication/bridge-profile.json.gz'); assert.ok(profileRef);
  const profileBytes = decodeDeliverySimulation(readDeliveryFile(options.world, profileRef), profileRef);
  const profile = JSON.parse(Buffer.from(profileBytes).toString()) as {origin: {originProjected: number[]}; bridges: ReconstructedBridge[]};
  const bridge = profile.bridges.find(b => b.id === 'hakaniemensilta'); assert.ok(bridge);
  assert.deepEqual(profile.origin.originProjected, source.origin.originProjected, 'Bridge frame changed');
  assert.notEqual(options.release, source.worldReleaseId, 'New geometry requires a new world release');
  const detail = legacyCentreBarCells(bridge), coarse = legacyCentreBarCells(bridge, true);
  const targetCells = Object.keys(CELL_COUNTS).sort();
  assert.deepEqual([...detail.keys()].sort(), targetCells); assert.deepEqual([...coarse.keys()].sort(), targetCells);
  const next = structuredClone(source) as unknown as Mutable<PublishedWorld>;
  next.worldReleaseId = options.release; next.builtAt = new Date().toISOString();
  const outputs = new Map<string, Uint8Array>(), changes: unknown[] = [], sourceReferences = references(source);
  const producer = Object.fromEntries(['remove_bridge_centre_bars.ts', 'lib/bridge-centre-bars.ts', 'lib/bridge-reconstruction.ts', 'lib/reuse-ground-glb.ts']
    .map(name => [name, deliverySha(fs.readFileSync(fileURLToPath(new URL(name, import.meta.url))))]));
  for (const ref of sourceReferences.values()) readDeliveryFile(options.world, ref);
  for (const id of targetCells) {
    const sourceCell = source.cells.find(c => c.id === id), cell = next.cells.find(c => c.id === id); assert.ok(sourceCell && cell);
    const expected = detail.get(id)!, expectedCoarse = coarse.get(id)!, counts = CELL_COUNTS[id as keyof typeof CELL_COUNTS];
    assert.equal([...expected.values()].reduce((n, v) => n + v, 0), counts.detail);
    assert.equal([...expectedCoarse.values()].reduce((n, v) => n + v, 0), counts.coarse);
    const cache = new Map<string, typeof cell.visual.lod0>();
    for (const level of ['lod0', 'lod1', 'lod2'] as const) {
      const ref: VisualLod | undefined = sourceCell.visual[level]; if (!ref) continue;
      const cached = cache.get(ref.path); if (cached) {cell.visual[level] = cached; continue;}
      const before = readDeliveryFile(options.world, ref), images = deliveryFacadeImages(options.world, ref, before, source.sharedTextures ?? []);
      const isCoarse = level === 'lod2', keys = isCoarse ? expectedCoarse : expected;
      const plan = planCentreBarVisualRemoval(await decodeDeliveryCityGlb(before, images), keys, isCoarse);
      const after = await reuseGroundGlb(before, plan.edits, []), a = readFacadeGlb(before), b = readFacadeGlb(after);
      assert.deepEqual(b.bin.subarray(0, a.bin.length), a.bin, 'Source compressed attributes and images changed');
      for (const key of ['accessors', 'bufferViews', 'meshes', 'materials', 'images', 'textures', 'samplers']) {
        const old = a.json[key] as unknown[] | undefined, current = b.json[key] as unknown[] | undefined;
        assert.deepEqual(current?.slice(0, old?.length), old, `Original ${key} changed`);
      }
      assert.equal(countCentreBarVisualTriangles(await decodeDeliveryCityGlb(after, images), keys), 0);
      const validationOptions = {maxIssues: 100, externalResourceFunction: async (uri: string) => {const data = images.get(uri); assert.ok(data); return data;}};
      const validation = await validateBytes(after, validationOptions);
      assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues.messages.filter(m => m.severity === 0)));
      const digest = deliverySha(after), stats = deliveryGeometryStats(after);
      assert.equal(stats.triangles, ref.triangles - plan.proof.removedTriangles);
      const target = {...ref, path: `cells/centre-bars.${id}.${level}.${digest.slice(0, 20)}.glb`, sha256: digest,
        bytes: after.length, triangles: stats.triangles, drawCalls: stats.drawCalls};
      cell.visual[level] = target; cache.set(ref.path, target); outputs.set(target.path, after);
      changes.push({cell: id, level, source: ref, target, ...plan.proof, gltfValidationErrors: 0,
        preservation: {originalBinPrefixAndAttributesMaterialsImages: true, allNonTargetIndicesLiteral: true}});
    }
    const before = decodeDeliverySimulation(readDeliveryFile(options.world, sourceCell.collision), sourceCell.collision);
    const physical = removeCentreBarCollision(before, expected), bounds = deliveryCollisionBounds(physical.bytes);
    assert.deepEqual(bounds.boundsXZ, sourceCell.collision.boundsXZ, 'Collision extent changed despite retaining every position');
    assert.equal(bounds.triangles, sourceCell.collision.triangles - counts.detail);
    const {bytes: compressed, ...transport} = encodeDeliverySimulation(physical.bytes), digest = deliverySha(compressed);
    const target = {...sourceCell.collision, ...transport, path: `cells/centre-bars.${id}.${digest.slice(0, 20)}.hcol.gz`,
      bytes: compressed.length, sha256: digest, triangles: bounds.triangles};
    cell.collision = target; outputs.set(target.path, compressed);
    changes.push({cell: id, collision: true, source: sourceCell.collision, target, ...physical.proof,
      visualCollisionTargetTrianglesIdentical: true, remainingCentreBarTriangles: 0});
    assert.deepEqual({...cell, visual: sourceCell.visual, collision: sourceCell.collision}, sourceCell);
  }
  for (const c of next.cells) if (!targetCells.includes(c.id)) assert.deepEqual(c, source.cells.find(old => old.id === c.id));
  const {cells: cellsAfter, worldReleaseId: releaseAfter, builtAt: timeAfter, ...unchanged} = next;
  const {cells: cellsBefore, worldReleaseId: releaseBefore, builtAt: timeBefore, ...expectedUnchanged} = source;
  assert.deepEqual(unchanged, expectedUnchanged, 'Unrelated manifest fields changed');
  const publication = Buffer.from(JSON.stringify({schemaVersion: 1, operation: 'bridge-raised-centre-bars-removal',
    bridge: bridge.id, sourceManifestSha256: sourceSha, sourceWorldRelease: source.worldReleaseId,
    profileSha256: deliverySha(profileBytes), producer, changes,
    preservation: {allOtherCellsAndPayloads: true, outerSafetyRailsGlassDeckAndTramTracks: true,
      physicalPositionArraysAndRetainedTriangleTags: true, previousPublicationProofs: 'historical-inputs-retained'}}) + '\n');
  const proofRef = {path: `publication/bridge-centre-bars-removal.${deliverySha(publication).slice(0, 20)}.json`, bytes: publication.length, sha256: deliverySha(publication)};
  next.publicationFiles.push(proofRef); outputs.set(proofRef.path, publication);
  assert.deepEqual(validateWorldManifest(next), []);
  const manifestBytes = Buffer.from(JSON.stringify(next, null, 1) + '\n'), refs = references(next);
  const worldBytes = manifestBytes.length + [...refs.values()].reduce((n, r) => n + r.bytes, 0);
  assert.ok(worldBytes <= 960_000_000 && refs.size + 1 < 10_000 && manifestBytes.length < 8_000_000, 'World delivery limits exceeded');
  assert.equal(deliverySha(fs.readFileSync(path.join(options.world, 'manifest.json'))), sourceSha);
  for (const [name, digest] of Object.entries(producer)) assert.equal(deliverySha(fs.readFileSync(fileURLToPath(new URL(name, import.meta.url)))), digest, 'Producer changed during qualification');
  freshDeliveryDirectory(options.world, options.out);
  for (const ref of refs.values()) {
    const file = deliveryFile(options.out, ref.path); fs.mkdirSync(path.dirname(file), {recursive: true});
    const bytes = outputs.get(ref.path);
    if (bytes) fs.writeFileSync(file, bytes, {flag: 'wx'});
    else {assert.deepEqual(sourceReferences.get(ref.path), ref); fs.linkSync(deliveryFile(options.world, ref.path), file);}
  }
  fs.writeFileSync(path.join(options.out, 'manifest.json'), manifestBytes, {flag: 'wx'});
  const receipt = {status: 'CENTRE_BARS_REMOVED_RUNTIME_CHECK_REQUIRED', release: next.worldReleaseId,
    manifestSha256: deliverySha(manifestBytes), sourceManifestSha256: sourceSha, worldBytes, files: refs.size + 1,
    changedCells: targetCells, changedVisualPayloads: 4, changedCollisionPayloads: 2, changes, publication: proofRef};
  if (options.receipt) {fs.mkdirSync(path.dirname(options.receipt), {recursive: true}); fs.writeFileSync(options.receipt, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});}
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {world: {type: 'string'}, out: {type: 'string'}, release: {type: 'string'}, receipt: {type: 'string'}, expected: {type: 'string'}}});
  assert.ok(values.world && values.out && values.release, '--world --out --release required');
  const result = await removeBridgeCentreBars({world: values.world, out: values.out, release: values.release, receipt: values.receipt, expected: values.expected});
  console.log(JSON.stringify({status: result.status, release: result.release, manifestSha256: result.manifestSha256,
    changedCells: result.changedCells, changedVisualPayloads: result.changedVisualPayloads, changedCollisionPayloads: result.changedCollisionPayloads, worldBytes: result.worldBytes}));
}

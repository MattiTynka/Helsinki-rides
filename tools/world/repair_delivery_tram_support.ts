// Fresh immutable derivative only; this command never changes the active release.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gzipSync} from 'node:zlib';
import {validateBytes} from 'gltf-validator';
import type {Primitive} from '@gltf-transform/core';
import {decodeSimulationPayload, parseCollisionBundle, validateWorldManifest, type FileRef, type WorldManifest} from '../../packages/world-schema/src/index.ts';
import {deliveryFacadeImages} from './apply_delivery_facade_charts.ts';
import {decodeDeliveryTramGlb} from './lib/tram-delivery.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';
import {appendSupportVisual, replaceSupportCollision, replaceSupportVisual, validateSupportPatch, type TramSupportPatch} from './lib/tram-support-repair.ts';

export const SUPPORT_BASELINE_SHA256 = '18e40f69a271f037b6b23b257fee437cb5716fad68c10cff808833a142ee7607';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const {values} = parseArgs({options: {world: {type: 'string'}, profile: {type: 'string'}, out: {type: 'string'}, release: {type: 'string'}, report: {type: 'string'}}});
assert.ok(values.world && values.profile && values.out && values.release && values.report, '--world --profile --out --release --report required');
assert.match(values.release, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const source = path.resolve(values.world), out = path.resolve(values.out), reportPath = path.resolve(values.report);
assert.ok(out !== source && !out.startsWith(source + path.sep) && !source.startsWith(out + path.sep));
assert.ok(!fs.existsSync(out) && !fs.existsSync(reportPath), 'Output world and report must be fresh');
const sourceBytes = fs.readFileSync(path.join(source, 'manifest.json')); assert.equal(sha(sourceBytes), SUPPORT_BASELINE_SHA256);
const manifest = JSON.parse(sourceBytes.toString()) as WorldManifest & {publicationFiles?: FileRef[]}; assert.deepEqual(validateWorldManifest(manifest), []);
const profileBytes = fs.readFileSync(values.profile), profile = JSON.parse(profileBytes.toString()) as {schemaVersion: number; sourceManifestSha256: string; patches: TramSupportPatch[]; extraClipCells?: {cell: string; patchIds: string[]}[]; proof: Record<string, unknown>};
assert.equal(profile.schemaVersion, 1); assert.equal(profile.sourceManifestSha256, SUPPORT_BASELINE_SHA256);
assert.ok(profile.patches.length > 0 && profile.patches.length <= 12); profile.patches.forEach(validateSupportPatch);
assert.ok(profile.proof.staticBoundariesPassed === true && profile.proof.gradeBoundPassed === true, 'Numeric source-bound boundary/grade proof must pass before world construction');
const boundaryProof = profile.proof.boundaryStations as {id: string; maxC0HeightErrorMetres: number; missingSupport: number; wheelProfiles: {holes: number; max5mmHeightJump: number}[]}[];
const topologyProof = profile.proof.topology as {id: string; uncoveredInteriorEdges: number; nonmanifoldEdges: number}[];
assert.equal(boundaryProof.length, profile.patches.length); assert.equal(topologyProof.length, profile.patches.length);
for (const row of boundaryProof) {assert.ok(Number.isFinite(row.maxC0HeightErrorMetres) && row.maxC0HeightErrorMetres <= .002 && row.missingSupport === 0); assert.ok(row.wheelProfiles.length >= 5 && row.wheelProfiles.every(v => v.holes === 0 && v.max5mmHeightJump <= .005));}
for (const row of topologyProof) assert.ok(row.uncoveredInteriorEdges === 0 && row.nonmanifoldEdges === 0);
for (const producer of profile.proof.producers as {path: string; sha256: string}[]) {assert.match(producer.path, /^tools\/world\/[A-Za-z0-9/_.-]+\.ts$/); assert.equal(sha(fs.readFileSync(path.resolve(producer.path))), producer.sha256, `Support producer drift: ${producer.path}`);}
const safe = (root: string, name: string) => {assert.ok(name.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p))); const file = path.resolve(root, ...name.split('/')); assert.ok(file.startsWith(root + path.sep)); return file;};
const read = (ref: FileRef) => {const file = safe(source, ref.path), stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink()); const b = fs.readFileSync(file); assert.equal(b.length, ref.bytes); assert.equal(sha(b), ref.sha256); return b;};
const outputs = new Map<string, Uint8Array>();
function add(name: string, bytes: Uint8Array): FileRef {assert.ok(!outputs.has(name)); outputs.set(name, bytes); return {path: name, bytes: bytes.length, sha256: sha(bytes)};}
function counts(bytes: Uint8Array) {const j = readFacadeGlb(bytes).json as any; let triangles = 0, drawCalls = 0; for (const n of j.nodes) if (n.mesh !== undefined) for (const p of j.meshes[n.mesh].primitives) {triangles += j.accessors[p.indices].count / 3; drawCalls++;} return {triangles, drawCalls};}
const changes: unknown[] = [], validations: unknown[] = [];
for (const cell of manifest.cells) {
  const authored = profile.patches.filter(p => p.cell === cell.id), extra = profile.extraClipCells?.find(c => c.cell === cell.id)?.patchIds ?? [], patches = profile.patches.filter(p => p.cell === cell.id || extra.includes(p.id)); if (!patches.length) continue;
  const before = structuredClone(cell), cache = new Map<string, object>();
  const nearBytes = read(cell.visual.lod0), nearImages = deliveryFacadeImages(source, cell.visual.lod0, nearBytes, manifest.sharedTextures ?? []), near = await decodeDeliveryTramGlb(nearBytes, nearImages), sourceGroundKeys = new Set<string>();
  for (const node of near.getRoot().listNodes()) if (node.getName().includes('_ground_') || /kerb/.test(node.getName())) for (const p of node.getMesh()?.listPrimitives() ?? []) {const P = p.getAttribute('POSITION')!, I = p.getIndices()!; for (let i = 0; i < I.getCount(); i += 3) sourceGroundKeys.add([0, 1, 2].map(k => P.getElement(I.getScalar(i + k), []).map(Math.fround).join(',')).sort().join('|'));}
  const visualClips: unknown[] = [];
  for (const [tier, ref] of Object.entries(cell.visual)) {
    const prior = cache.get(ref.path); if (prior) {Object.assign(ref, prior); continue;}
    const original = read(ref), images = deliveryFacadeImages(source, ref, original, manifest.sharedTextures ?? []), doc = await decodeDeliveryTramGlb(original, images);
    const clipped = await replaceSupportVisual(original, doc, patches, sourceGroundKeys, tier === 'lod2'), clippedDoc = await decodeDeliveryTramGlb(clipped.bytes, images), result = await appendSupportVisual(clipped.bytes, clippedDoc, authored, tier === 'lod2'), next = await decodeDeliveryTramGlb(result, images);
    visualClips.push({tier, sourceFacets: clipped.proof});
    // Original attribute data stays literal; only bounded ground index lists change.
    for (const n of doc.getRoot().listNodes()) {
      const nn = next.getRoot().listNodes().find(v => v.getName() === n.getName()); assert.ok(nn); assert.deepEqual(nn.getMatrix(), n.getMatrix());
      for (const [i, p] of (n.getMesh()?.listPrimitives() ?? []).entries()) {
        const q: Primitive = nn.getMesh()!.listPrimitives()[i]!; assert.equal(q.getMaterial()?.getName(), p.getMaterial()?.getName());
        const selected = (clipped.proof as {node: string; primitive: number}[]).some(v => v.node === n.getName() && v.primitive === i);
        for (const semantic of [...p.listSemantics(), ...(!selected ? ['indices'] : [])]) {const a = (semantic === 'indices' ? p.getIndices() : p.getAttribute(semantic))!.getArray()!, b = (semantic === 'indices' ? q.getIndices() : q.getAttribute(semantic))!.getArray()!; assert.deepEqual(b.subarray(0, a.length), a);}
      }
    }
    const validationOptions = {maxIssues: 200, externalResourceFunction: async (uri: string) => {const data = images.get(uri); assert.ok(data); return data;}};
    const validation = await validateBytes(result, validationOptions);
    assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues.messages.filter(m => m.severity === 0))); validations.push({cell: cell.id, tier, errors: 0, warnings: validation.issues.numWarnings});
    const digest = sha(result), nextRef = {...add(`cells/${cell.id}.${tier}.${digest.slice(0, 16)}.glb`, result), ...counts(result)}; cache.set(ref.path, nextRef); Object.assign(ref, nextRef);
  }
  const original = await decodeSimulationPayload(read(cell.collision), cell.collision), collision = replaceSupportCollision(original, patches, authored), result = collision.bytes, bundle = parseCollisionBundle(result), stored = gzipSync(result, {level: 6}), digest = sha(stored);
  const boundsXZ = [Infinity, Infinity, -Infinity, -Infinity];
  for (const collider of bundle.colliders) for (const i of collider.indices) {const x = collider.positions[i * 3]!, z = collider.positions[i * 3 + 2]!; boundsXZ[0] = Math.min(boundsXZ[0]!, x); boundsXZ[1] = Math.min(boundsXZ[1]!, z); boundsXZ[2] = Math.max(boundsXZ[2]!, x); boundsXZ[3] = Math.max(boundsXZ[3]!, z);}
  Object.assign(cell.collision, add(`cells/${cell.id}.tram-support.${digest.slice(0, 16)}.hcol.gz`, stored), {compression: 'gzip', decodedBytes: result.length, decodedSha256: sha(result), triangles: bundle.colliders.reduce((n, c) => n + c.indices.length / 3, 0), boundsXZ});
  changes.push({cell: cell.id, before, after: structuredClone(cell), patches: patches.map(p => p.id), authoredTriangles: patches.reduce((n, p) => n + p.triangles.length, 0), visualClips, collisionClips: collision.proof});
}
assert.equal(changes.length, new Set([...profile.patches.map(p => p.cell), ...(profile.extraClipCells ?? []).map(c => c.cell)]).size);
const receipt = {schemaVersion: 1, sourceManifestSha256: SUPPORT_BASELINE_SHA256, sourceRelease: manifest.worldReleaseId, release: values.release, profileSha256: sha(profileBytes), patches: profile.patches.map(({triangles, ...p}) => ({...p, triangles: triangles.length})), proof: profile.proof, changes, validations, preservation: {allOriginalCompressedBinBytes: true, originalAttributeArrayPrefixes: true, originalOutsideGroundFragments: true, nonGroundColliders: true, sourceMaterialsUvsAndImages: true, terrainAndUnrelatedCells: true}, status: 'STATIC_GATES_PASSED_RUNTIME_REQUIRED'};
manifest.publicationFiles = [...(manifest.publicationFiles ?? []), add('publication/tram-support-repair.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'))];
manifest.publicationFiles.push(add('publication/tram-support-profile.json', profileBytes));
(manifest as any).worldReleaseId = values.release; (manifest as any).builtAt = new Date().toISOString(); assert.deepEqual(validateWorldManifest(manifest), []);
const refs = new Map<string, FileRef>();
function collect(value: unknown) {if (!value || typeof value !== 'object') return; const v = value as Record<string, unknown>; if (typeof v.path === 'string' && typeof v.sha256 === 'string' && typeof v.bytes === 'number') {const r = v as unknown as FileRef, old = refs.get(r.path); assert.ok(!old || old.sha256 === r.sha256); refs.set(r.path, r);} for (const child of Object.values(v)) collect(child);}
collect(manifest); fs.mkdirSync(out, {recursive: true});
for (const ref of refs.values()) {const file = safe(out, ref.path); fs.mkdirSync(path.dirname(file), {recursive: true}); const bytes = outputs.get(ref.path); if (bytes) fs.writeFileSync(file, bytes, {flag: 'wx'}); else {read(ref); fs.linkSync(safe(source, ref.path), file);} assert.equal(sha(fs.readFileSync(file)), ref.sha256);}
const finalBytes = Buffer.from(JSON.stringify(manifest, null, 1) + '\n'); fs.writeFileSync(path.join(out, 'manifest.json'), finalBytes, {flag: 'wx'});
assert.equal(sha(fs.readFileSync(path.join(source, 'manifest.json'))), SUPPORT_BASELINE_SHA256); assert.equal(sha(fs.readFileSync(values.profile)), sha(profileBytes));
fs.mkdirSync(path.dirname(reportPath), {recursive: true}); fs.writeFileSync(reportPath, JSON.stringify({...receipt, manifestSha256: sha(finalBytes), files: refs.size + 1, bytes: finalBytes.length + [...refs.values()].reduce((n, r) => n + r.bytes, 0)}, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: receipt.status, release: values.release, manifestSha256: sha(finalBytes), cells: changes.length}));

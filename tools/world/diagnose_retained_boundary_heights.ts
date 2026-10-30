// Read-only native-cache seam diagnostic; this never repairs roads or confers final serialized support.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {deserialize} from 'node:v8';
import {parseArgs} from 'node:util';
import {decodeRoadGraph, decodeSimulationPayload, type Vec3} from '../../packages/world-schema/src/index.ts';
import {RoadCollisionSupport, isPublicWalkingGroundTag, type RoadSupportTriangle} from './lib/expansion-road-merge.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
const {values} = parseArgs({options: {plan: {type: 'string'}, out: {type: 'string'}}}); assert.ok(values.plan && values.out && !fs.existsSync(values.out));
const pin = (ref: {file: string; sha256: string}, cap = 512_000_000) => {const stat = fs.lstatSync(ref.file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= cap); const bytes = fs.readFileSync(ref.file); assert.equal(sourceSha256(bytes), ref.sha256); return bytes;};
const planBytes = fs.readFileSync(values.plan), plan = JSON.parse(planBytes.toString()), inventory = JSON.parse(pin(plan.inventory).toString()), metadata = JSON.parse(pin(plan.nativeMetadata).toString());
assert.equal(metadata.kind, 'native-delivery-ground-cache'); assert.equal(metadata.target[1], 768); assert.equal(metadata.target[3], 1792);
const manifest = JSON.parse(pin({file: path.join(plan.acceptedWorld, 'manifest.json'), sha256: plan.acceptedManifestSha256}).toString()); assert.equal(inventory.acceptedManifestSha256, plan.acceptedManifestSha256);
for (const ref of Object.values(metadata.inputs) as {path: string; sha256: string}[]) pin({file: ref.path, sha256: ref.sha256});
for (const [file, sha256] of Object.entries(metadata.producerHashes) as [string, string][]) pin({file: path.resolve(metadata.producerRoot, file), sha256});
const accepted = decodeRoadGraph(await decodeSimulationPayload(readSourceFile(plan.acceptedWorld, manifest.roads), manifest.roads)), gameplay = JSON.parse(readSourceFile(plan.acceptedWorld, manifest.gameplay).toString()), frontier = gameplay.playArea.maxZ;
const queries: {kind: 'lanes' | 'footways'; id: string; point: Vec3; segment: number; name: string | null}[] = [];
for (const kind of ['lanes', 'footways'] as const) {const exposed = new Map(inventory.groups.find((g: any) => g.kind === kind).exposed.map((r: any) => [r.id, r]));
  for (const record of accepted[kind]) if (exposed.has(record.id)) for (let i = 1; i < record.points.length; i++) {const a = record.points[i - 1]!, b = record.points[i]!, dz = b[2] - a[2]; if (!dz || Math.min(a[2], b[2]) > frontier || Math.max(a[2], b[2]) < frontier) continue;
    const t = (frontier - a[2]) / dz; queries.push({kind, id: record.id, segment: i - 1, name: 'name' in record ? String(record.name ?? '') : null, point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, frontier]});
  }
}
assert.ok(queries.length > 0 && queries.length <= 1000);
const cacheBytes = pin({file: metadata.cache.path, sha256: metadata.cache.sha256}); assert.equal(cacheBytes.length, metadata.cache.bytes);
const cache = deserialize(cacheBytes) as {ground: {pieces: {cell: string; tag: string; positions: number[]; indices: number[]}[]}}, triangles: RoadSupportTriangle[] = [];
let ordinal = 0;
for (const piece of cache.ground.pieces) if (piece.tag.startsWith('road:') || isPublicWalkingGroundTag(piece.tag)) for (let i = 0; i < piece.indices.length; i += 3) {
  ordinal++; const points = [0, 1, 2].map(k => piece.positions.slice(piece.indices[i + k]! * 3, piece.indices[i + k]! * 3 + 3) as Vec3), x0 = Math.min(...points.map(p => p[0])), x1 = Math.max(...points.map(p => p[0])), z0 = Math.min(...points.map(p => p[2])), z1 = Math.max(...points.map(p => p[2]));
  if (!queries.some(q => q.point[0] >= x0 - .01 && q.point[0] <= x1 + .01 && q.point[2] >= z0 - .51 && q.point[2] <= z1 + .51)) continue;
  triangles.push({id: `${piece.cell}:${ordinal}`, points: points as [Vec3, Vec3, Vec3], tag: piece.tag});
}
const road = new RoadCollisionSupport(triangles), walking = new RoadCollisionSupport(triangles, isPublicWalkingGroundTag);
const results = queries.map(query => {const [x, y, z] = query.point, support = query.kind === 'lanes' ? road : walking, native = [-.5, -.01, 0, .01, .5].map(offset => {
  try {const projected = support.project(x, z + offset); return {offsetZ: offset, height: projected?.height ?? null, oldGraphDeviation: projected ? projected.height - y : null, sourceTriangles: projected?.triangles ?? [], matchingOldGraphSupport: support.at(x, y, z + offset)};}
  catch (error) {return {offsetZ: offset, error: (error as Error).message, matchingOldGraphSupport: support.at(x, y, z + offset)};}
}); return {...query, native, protectedBoundaryWithinExistingHeightGate: !!native.find(sample => sample.offsetZ === 0)?.matchingOldGraphSupport};});
const report = {schemaVersion: 1, status: 'NATIVE_CACHE_FRONTIER_DIAGNOSTIC_NOT_SERIALIZED_OR_RUNTIME_ACCEPTANCE', acceptedManifestSha256: plan.acceptedManifestSha256, planSha256: sourceSha256(planBytes), nativeMetadata: plan.nativeMetadata, nativeCache: metadata.cache,
  producerHashesVerified: true, inventory: plan.inventory, existingHeightToleranceMetres: .2, inspectedTriangles: triangles.length, records: results, unsupportedProtectedBoundaries: results.filter(result => !result.protectedBoundaryWithinExistingHeightGate).map(result => ({kind: result.kind, id: result.id, point: result.point}))};
fs.mkdirSync(values.out, {recursive: true}); const ref = writeSourceJson(values.out, 'retained-boundary-native-heights.json', report); console.log(JSON.stringify({file: path.resolve(values.out, ref.path), sha256: ref.sha256, records: results.length, unsupported: report.unsupportedProtectedBoundaries.length, triangles: triangles.length}));

// Read-only point classification against pinned municipal sources and serialized ground.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {decodeSimulationPayload, parseCollisionBundle, type Vec3} from '../../packages/world-schema/src/index.ts';
import {loadGeoJsonPolygons, pointInPolygon} from './lib/geometry.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';

const {values} = parseArgs({options: {plan: {type: 'string'}, queries: {type: 'string'}, out: {type: 'string'}}});
assert.ok(values.plan && values.queries && values.out && !fs.existsSync(values.out), 'Pinned merge plan, point queries and fresh output are required');
const pin = (file: string, sha256?: string, cap = 128_000_000) => {
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= cap);
  const bytes = fs.readFileSync(file), actual = sourceSha256(bytes); if (sha256) assert.equal(actual, sha256);
  return {file: path.resolve(file), sha256: actual, bytes: bytes.length, json: JSON.parse(bytes.toString())};
};
const planPin = pin(values.plan, undefined, 16_000_000), plan = planPin.json;
const queryPin = pin(values.queries, undefined, 2_000_000);
const queries = queryPin.json as {id: string; point: Vec3}[];
assert.ok(Array.isArray(queries) && queries.length > 0 && queries.length <= 2048);
assert.ok(queries.every(q => typeof q.id === 'string' && q.id.length <= 256 && q.point.length === 3 && q.point.every(Number.isFinite)));
const manifestPin = pin(path.join(plan.acceptedWorld, 'manifest.json'), plan.expectedManifestSha256, 8_000_000), manifest = manifestPin.json;
const indexPin = pin(path.join(plan.nativeCells.directory, 'cells.json'), plan.nativeCells.indexSha256, 16_000_000);
assert.equal(indexPin.json.originId, manifest.origin.id);
const streetsPin = pin(plan.streetParts.file, plan.streetParts.sha256), osmPin = pin(plan.osm.file, plan.osm.sha256);
const parts = loadGeoJsonPolygons(streetsPin.file, manifest.origin.originProjected[0], manifest.origin.originProjected[1], (p, i) => String(p.osan_id ?? p.id ?? i));
const results = queries.map(q => ({...q, hits: [] as {id: string; tag: string; height: number; deviation: number; normalY: number; points: Vec3[]}[],
  municipalParts: parts.filter(p => pointInPolygon([q.point[0], -q.point[2]], p.rings)).map(p => ({id: p.id, properties: p.properties})),
  sourceWay: osmPin.json.elements.find((e: any) => e.type === 'way' && String(e.id) === q.id.replace(/^w/, '').split(':')[0]) ?? null}));
const collisionInputs: unknown[] = [];
for (const source of [{kind: 'accepted', root: plan.acceptedWorld, cells: manifest.cells}, {kind: 'native', root: plan.nativeCells.directory, cells: indexPin.json.cells}]) {
  for (const cell of source.cells) {
    const b = cell.collision.boundsXZ ?? cell.boundsXZ;
    const selected = results.filter(q => q.point[0] >= b[0] && q.point[0] <= b[2] && q.point[2] >= b[1] && q.point[2] <= b[3]);
    if (!selected.length) continue;
    const decoded = await decodeSimulationPayload(readSourceFile(source.root, cell.collision), cell.collision), bundle = parseCollisionBundle(decoded);
    assert.equal(bundle.header.cell, cell.id); assert.equal(bundle.header.originId, manifest.origin.id);
    collisionInputs.push({kind: source.kind, cell: cell.id, storedSha256: cell.collision.sha256, decodedSha256: sourceSha256(decoded)});
    for (const collider of bundle.colliders) if (collider.group === 'ground') for (let i = 0; i < collider.indices.length; i += 3) {
      const points = [0, 1, 2].map(k => Array.from(collider.positions.subarray(collider.indices[i + k]! * 3, collider.indices[i + k]! * 3 + 3)) as Vec3);
      const [a, b, c] = points as [Vec3, Vec3, Vec3], denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      if (Math.abs(denominator) < 1e-12) continue;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const ny = uz * vx - ux * vz, normalY = ny / Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
      for (const query of selected) {
        const [x, y, z] = query.point, u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
        const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator, w = 1 - u - v;
        if (Math.min(u, v, w) < -1e-7) continue;
        const height = u * a[1] + v * b[1] + w * c[1];
        query.hits.push({id: `${source.kind}:${cell.id}:${collider.id}:${i / 3}`, tag: bundle.header.surfaceTags[collider.triangleTags[i / 3]!]!, height, deviation: height - y, normalY, points});
      }
    }
  }
}
const withoutJson = ({json: _json, ...ref}: ReturnType<typeof pin>) => ref;
const report = {schemaVersion: 1, status: 'SOURCE_SERIALIZED_GROUND_POINT_DIAGNOSTIC_NOT_TRAVEL_ACCEPTANCE', plan: withoutJson(planPin), queries: withoutJson(queryPin), manifest: withoutJson(manifestPin), index: withoutJson(indexPin), streets: withoutJson(streetsPin), osm: withoutJson(osmPin), collisionInputs, results, producerSha256: sourceSha256(fs.readFileSync(import.meta.filename))};
fs.mkdirSync(values.out, {recursive: true}); const ref = writeSourceJson(values.out, 'surface-points.json', report);
console.log(JSON.stringify({file: path.resolve(values.out, ref.path), sha256: ref.sha256, queries: results.length, collisionInputs: collisionInputs.length, witnesses: results.reduce((n, q) => n + q.hits.length, 0)}));
